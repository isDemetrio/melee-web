/**
 * The play worker's per-frame meter (web/src/play/worker.ts): where one frame's wall time goes,
 * measured in the worker, on the worker's clock, without touching the core or `wasm/render/`.
 *
 * A frame is one cycle of the worker, from the end of one retrace's presentation to the end of the
 * next one's. It is cut into consecutive parts by clock reads, so they add up to the cycle exactly:
 *
 * - `core`: `callMain` runs until the next retrace beat (`Module.heartbeat(r)`): the simulation, GX
 *   decoding, the backend's JavaScript and C++, and every WebGPU call it makes. Inside it, measured
 *   separately and included in it:
 *   - `webgpu`: time inside WebGPU calls, read around each call (`instrumentGpu`), by method;
 *   - `disc`: time inside WORKERFS reads of the disc (`meterDiscReads`);
 *   - with the core split on, the core profiler's `decode_ms` / `non_decode_ms` (patch 0008):
 *     GX decoding (draw recording, texture snapshots, the backend) against everything else.
 * - `bitmap`: `OffscreenCanvas.transferToImageBitmap`. A browser that waits for the GPU before it
 *   hands the frame over would wait here.
 * - `ack`: posting the frame and waiting for the page to present it (shared-pad.ts, PRESENTED). The
 *   page's main thread being busy shows up here.
 * - `probe`: only in a presentation probe session (presentation.ts, TransferProbe): a transfer of a
 *   canvas of its own, with nothing queued behind it. 0 in every other frame.
 * - `idle`: the 60 Hz pacing wait, i.e. time left over. A frame that is late has none.
 *
 * What it cannot see: the time the browser's GPU process and the GPU spend after a call has returned.
 * On WebKit every call is a message to the GPU process; only the synchronous part of sending it is in
 * `webgpu`. GPU completion cannot be observed at all here: `callMain` never yields, so no promise --
 * `onSubmittedWorkDone`, `mapAsync` -- resolves while the game runs. Work the GPU process has not
 * finished shows up only where a later synchronous call has to wait for it.
 *
 * The flight recorder is a few words of shared memory the page reads on every animation frame: the
 * last completed frame, what the worker is doing right now (phase, and which WebGPU method), and the
 * draws so far in this frame. A frozen worker cannot post, but the page can still read where it is.
 */

export const PHASES = ['boot', 'core', 'webgpu', 'disc', 'bitmap', 'ack', 'idle', 'probe'] as const;
export type Phase = (typeof PHASES)[number];
const BOOT = 0, CORE = 1, WEBGPU = 2, DISC = 3, BITMAP = 4, ACK = 5, IDLE = 6, PROBE = 7;

/** Flight recorder words (Int32). The page writes HIDDEN; the worker writes the rest. */
export const FLIGHT_FRAME = 0;
export const FLIGHT_PHASE = 1;
export const FLIGHT_CALL = 2;
export const FLIGHT_DRAWS = 3;
export const FLIGHT_HIDDEN = 4;
export const FLIGHT_MATCH = 5;
export const FLIGHT_WORDS = 6;
export function createFlight(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(FLIGHT_WORDS * Int32Array.BYTES_PER_ELEMENT));
}

const DEVICE_METHODS = ['createCommandEncoder', 'createTexture', 'createBindGroup', 'createSampler',
  'createRenderPipeline', 'createShaderModule', 'createBuffer', 'createBindGroupLayout', 'createPipelineLayout'] as const;
const QUEUE_METHODS = ['writeBuffer', 'writeTexture', 'submit'] as const;
const ENCODER_METHODS = ['beginRenderPass', 'copyTextureToTexture', 'copyTextureToBuffer', 'finish'] as const;
const PASS_METHODS = ['setPipeline', 'setBindGroup', 'setViewport', 'setScissorRect', 'setVertexBuffer',
  'setIndexBuffer', 'drawIndexed', 'draw', 'end'] as const;

/** Every WebGPU method the meter times, by the name the report uses. Index = flight recorder CALL. */
export const METHODS: readonly string[] = [
  ...DEVICE_METHODS.map((name) => `device.${name}`),
  ...QUEUE_METHODS.map((name) => `queue.${name}`),
  ...ENCODER_METHODS.map((name) => `encoder.${name}`),
  ...PASS_METHODS.map((name) => `pass.${name}`),
  'context.getCurrentTexture', 'texture.createView', 'texture.destroy', 'buffer.destroy',
];
const METHOD_ID = new Map(METHODS.map((name, index) => [name, index]));

/** `resources`: objects made or destroyed; `encode`: recording commands; `queue`: writes and submits. */
export type Category = 'resources' | 'encode' | 'queue' | 'present';
export function categoryOf(method: string): Category {
  if (method.startsWith('queue.')) return 'queue';
  if (method === 'device.createCommandEncoder' || method.startsWith('encoder.') || method.startsWith('pass.')) return 'encode';
  if (method === 'context.getCurrentTexture') return 'present';
  return 'resources';
}
const CATEGORY = METHODS.map(categoryOf);
/** A frame's new GPU objects: `device.create*` except the encoder, which every frame makes. */
const CREATES = METHODS.map((name) => name.startsWith('device.create') && name !== 'device.createCommandEncoder');
const PIPELINE = METHOD_ID.get('device.createRenderPipeline')!;

/** One row per frame, in this order. `null` is "not measured in this session" (the core split). */
export const FRAME_COLUMNS = ['retrace', 'match_frame', 'cycle_ms', 'core_ms', 'webgpu_ms', 'webgpu_calls', 'draws',
  'resources_ms', 'encode_ms', 'queue_ms', 'present_ms', 'created', 'pipelines_created', 'disc_ms', 'disc_bytes',
  'bitmap_ms', 'ack_ms', 'idle_ms', 'hidden', 'decode_ms', 'non_decode_ms',
  'sim_ms', 'previous_heartbeat_tail_ms', 'csv_write_ms', 'heartbeat_read_ms', 'heartbeat_finish_ms',
  'core_unattributed_ms', 'native_pre_heartbeat_ms', 'previous_native_roundtrip_ms',
  'previous_js_heartbeat_ms', 'previous_js_return_to_resume_probe_ms',
  'previous_bridge_outside_js_ms', 'bridge_entry_ms', 'residual_unexplained_ms',
  // Presentation (presentation.ts): how the canvas got its picture (PRESENT_*), and the transfer probe,
  // null in frames without one: its whole time, the transfer alone, the probe canvas's pixels and format.
  'present_mode', 'probe_ms', 'probe_transfer_ms', 'probe_px', 'probe_bgra'] as const;
export type FrameColumn = (typeof FRAME_COLUMNS)[number];
export const COLUMN = Object.fromEntries(FRAME_COLUMNS.map((name, index) => [name, index])) as Record<FrameColumn, number>;

/** A frame at least this long is a slow frame: three 60 Hz periods, a stutter anyone sees. */
export const SLOW_FRAME_MS = 50;

export interface FrameRecord {
  row: (number | null)[];
  /** Slow frames only: the three WebGPU methods that took longest in it, [method, calls, ms]. */
  top?: [method: string, calls: number, ms: number][];
}

export interface MethodTotal { calls: number; ms: number }
export interface MethodTotals {
  all: Record<string, MethodTotal>;
  in_match: Record<string, MethodTotal>;
  /** The longest single call of each method, and the retrace whose frame it was in. */
  longest: Record<string, { ms: number; retrace: number }>;
}

/** The core profiler's split of `core_ms` for one retrace (decoder_cost.csv, patch 0008). */
export interface CoreTiming { retrace: number; simMs: number; csvMs: number }
export interface BridgeTiming {
  nativePreMs: number; previousRetrace: number; nativeRoundtripMs: number; entered: number;
}
export interface HeartbeatTiming { entered: number; readDone: number; core: CoreTiming | null; bridge?: BridgeTiming }

export interface CoreSplit { decodeMs: number; nonDecodeMs: number }
/** One transfer probe (presentation.ts): the transfer alone, and the probe canvas's pixels and format. */
export interface ProbeTiming { transferMs: number; px: number; bgra: boolean }

const round = (value: number): number => Math.round(value * 1000) / 1000;

interface Bucket { calls: Float64Array; ms: Float64Array }
const bucket = (): Bucket => ({ calls: new Float64Array(METHODS.length), ms: new Float64Array(METHODS.length) });

export class FrameMeter {
  private readonly calls = new Float64Array(METHODS.length);
  private readonly ms = new Float64Array(METHODS.length);
  private readonly all = bucket();
  private readonly inMatch = bucket();
  private readonly longestMs = new Float64Array(METHODS.length);
  private readonly longestAt = new Float64Array(METHODS.length);
  /** Things the meter could not attach to, for the report. */
  readonly notes: string[] = [];
  private cycleStart: number;
  private coreEndAt = 0;
  private bitmapEndAt = 0;
  private ackEndAt = 0;
  private probeEndAt = 0;
  private presentMode = 0;
  private probe: ProbeTiming | null = null;
  private resume = BOOT;
  private draws = 0;
  private discMs = 0;
  private discBytes = 0;
  private retrace = 0;
  private matchFrame: number | null = null;
  private split: CoreSplit | null = null;
  private hidden = false;
  private heartbeatTiming: HeartbeatTiming | null = null;
  private returnedAt: number | null = null;
  private returnedRetrace = 0;
  private bridgeEntered: number | null = null;
  private jsSpan: number | null = null;
  private resumeProbe: { retrace: number; ms: number } | null = null;

  heartbeatResuming(retrace: number): void {
    const at = this.now();
    this.resumeProbe = this.returnedAt !== null && this.returnedRetrace === retrace
      ? { retrace, ms: at - this.returnedAt } : null;
  }

  /** Called by the WASM bridge AFTER heartbeat returns; charged to the next cycle. */
  heartbeatReturned(retrace: number): void {
    this.returnedAt = this.now();
    this.returnedRetrace = retrace;
    this.jsSpan = this.bridgeEntered === null ? null : this.returnedAt - this.bridgeEntered;
  }

  methodSnapshot(): Record<string, MethodTotal> {
    return Object.fromEntries(METHODS.map((name, i) => [name, { calls: this.calls[i]!, ms: this.ms[i]! }]));
  }

  constructor(private readonly flight: Int32Array, private readonly now: () => number) {
    this.cycleStart = now();
    flight[FLIGHT_PHASE] = BOOT;
  }

  /**
   * The first frame starts now. Calls made before -- the backend's attach -- belong to no frame and
   * are dropped from the counts, as is the longest-call record they set.
   */
  start(): void {
    this.calls.fill(0);
    this.ms.fill(0);
    this.longestMs.fill(0);
    this.draws = 0;
    this.discMs = 0;
    this.discBytes = 0;
    this.flight[FLIGHT_PHASE] = CORE;
    this.cycleStart = this.now();
  }

  enter(method: number): number {
    this.resume = this.flight[FLIGHT_PHASE]!;
    this.flight[FLIGHT_PHASE] = WEBGPU;
    this.flight[FLIGHT_CALL] = method;
    return this.now();
  }

  leave(method: number, started: number): void {
    const ms = this.now() - started;
    this.ms[method] = this.ms[method]! + ms;
    this.calls[method] = this.calls[method]! + 1;
    if (ms > this.longestMs[method]!) { this.longestMs[method] = ms; this.longestAt[method] = this.retrace + 1; }
    this.flight[FLIGHT_PHASE] = this.resume;
  }

  enterDisc(): number {
    this.resume = this.flight[FLIGHT_PHASE]!;
    this.flight[FLIGHT_PHASE] = DISC;
    return this.now();
  }

  leaveDisc(started: number, bytes: number): void {
    this.discMs += this.now() - started;
    this.discBytes += bytes;
    this.flight[FLIGHT_PHASE] = this.resume;
  }

  /** The renderer's per-draw beat (`Module.heartbeat(-1)`). */
  draw(): void {
    this.draws++;
    this.flight[FLIGHT_DRAWS] = this.draws;
  }

  /** The retrace beat: the core part of the frame ends; presentation starts. */
  coreEnd(retrace: number, matchFrame: number | null, split: CoreSplit | null, timing: HeartbeatTiming | null = null): void {
    this.coreEndAt = this.now();
    this.retrace = retrace;
    this.matchFrame = matchFrame;
    this.split = split;
    this.heartbeatTiming = timing;
    this.hidden = this.flight[FLIGHT_HIDDEN] !== 0;
    this.flight[FLIGHT_FRAME] = retrace;
    this.flight[FLIGHT_MATCH] = matchFrame !== null && matchFrame > 0 ? 1 : 0;
    this.flight[FLIGHT_PHASE] = BITMAP;
  }

  /** `presentMode`: presentation.ts's PRESENT_*; 0 is the path every session took before it. */
  bitmapDone(presentMode = 0): void {
    this.bitmapEndAt = this.now();
    this.presentMode = presentMode;
    this.flight[FLIGHT_PHASE] = ACK;
  }

  ackDone(): void {
    this.ackEndAt = this.probeEndAt = this.now();
    this.probe = null;
    // A hidden page does not present, so a frame that waited for it is not a slow frame.
    this.hidden ||= this.flight[FLIGHT_HIDDEN] !== 0;
    this.flight[FLIGHT_PHASE] = IDLE;
  }

  /** A transfer probe starts (presentation.ts); probeDone ends it, with null when none ran. */
  probeStart(): void {
    this.flight[FLIGHT_PHASE] = PROBE;
  }

  probeDone(result: ProbeTiming | null): void {
    // Without a probe the frame has no probe part: the time since ackDone stays idle.
    if (result) this.probeEndAt = this.now();
    this.probe = result;
    this.flight[FLIGHT_PHASE] = IDLE;
  }

  /** The pacing wait is over: the frame's record, and the next frame's core part starts. */
  cycleEnd(): FrameRecord {
    const end = this.now();
    const match = this.matchFrame !== null && this.matchFrame > 0;
    let webgpuMs = 0, calls = 0, created = 0;
    const category: Record<Category, number> = { resources: 0, encode: 0, queue: 0, present: 0 };
    for (let i = 0; i < METHODS.length; i++) {
      const n = this.calls[i]!;
      if (!n) continue;
      const ms = this.ms[i]!;
      webgpuMs += ms;
      calls += n;
      category[CATEGORY[i]!] += ms;
      if (CREATES[i]) created += n;
      this.all.calls[i] = this.all.calls[i]! + n;
      this.all.ms[i] = this.all.ms[i]! + ms;
      if (match) {
        this.inMatch.calls[i] = this.inMatch.calls[i]! + n;
        this.inMatch.ms[i] = this.inMatch.ms[i]! + ms;
      }
    }
    const cycle = end - this.cycleStart;
    const timing = this.heartbeatTiming;
    const core = timing?.core?.retrace === this.retrace ? timing.core : null;
    const tail = this.returnedAt !== null && this.returnedRetrace === this.retrace - 1
      ? this.returnedAt - this.cycleStart : null;
    const read = timing ? timing.readDone - timing.entered : null;
    const finish = timing ? this.coreEndAt - timing.readDone : null;
    const residual = core && tail !== null && read !== null && finish !== null
      ? this.coreEndAt - this.cycleStart - core.simMs - core.csvMs - tail - read - finish : null;
    const bridge = timing?.bridge;
    const joined = core && bridge && bridge.previousRetrace === this.retrace - 1 &&
      this.returnedRetrace === bridge.previousRetrace && this.resumeProbe?.retrace === bridge.previousRetrace &&
      this.jsSpan !== null && residual !== null;
    const probe = joined ? this.resumeProbe!.ms : null;
    const outside = joined ? bridge.nativeRoundtripMs - this.jsSpan! - probe! : null;
    const ingress = bridge && timing ? timing.entered - bridge.entered : null;
    const unexplained = joined ? residual - bridge.nativePreMs - probe! - outside! - ingress! : null;
    const values: Record<FrameColumn, number | null> = {
      native_pre_heartbeat_ms: core && bridge ? round(bridge.nativePreMs) : null,
      previous_native_roundtrip_ms: joined ? round(bridge.nativeRoundtripMs) : null,
      previous_js_heartbeat_ms: joined ? round(this.jsSpan!) : null,
      previous_js_return_to_resume_probe_ms: probe === null ? null : round(probe),
      previous_bridge_outside_js_ms: outside === null ? null : round(outside),
      bridge_entry_ms: ingress === null ? null : round(ingress),
      residual_unexplained_ms: unexplained === null ? null : round(unexplained),
      sim_ms: core ? round(core.simMs) : null,
      previous_heartbeat_tail_ms: tail === null ? null : round(tail),
      csv_write_ms: core ? round(core.csvMs) : null,
      heartbeat_read_ms: read === null ? null : round(read),
      heartbeat_finish_ms: finish === null ? null : round(finish),
      core_unattributed_ms: residual === null ? null : round(residual),
      retrace: this.retrace, match_frame: this.matchFrame, cycle_ms: round(cycle),
      core_ms: round(this.coreEndAt - this.cycleStart), webgpu_ms: round(webgpuMs), webgpu_calls: calls,
      draws: this.draws, resources_ms: round(category.resources), encode_ms: round(category.encode),
      queue_ms: round(category.queue), present_ms: round(category.present), created,
      pipelines_created: this.calls[PIPELINE]!, disc_ms: round(this.discMs), disc_bytes: this.discBytes,
      bitmap_ms: round(this.bitmapEndAt - this.coreEndAt), ack_ms: round(this.ackEndAt - this.bitmapEndAt),
      idle_ms: round(end - this.probeEndAt), hidden: this.hidden ? 1 : 0,
      present_mode: this.presentMode, probe_ms: this.probe ? round(this.probeEndAt - this.ackEndAt) : null,
      probe_transfer_ms: this.probe ? round(this.probe.transferMs) : null, probe_px: this.probe?.px ?? null,
      probe_bgra: this.probe ? (this.probe.bgra ? 1 : 0) : null,
      decode_ms: this.split ? round(this.split.decodeMs) : null,
      non_decode_ms: this.split ? round(this.split.nonDecodeMs) : null,
    };
    const record: FrameRecord = { row: FRAME_COLUMNS.map((name) => values[name]) };
    if (cycle >= SLOW_FRAME_MS) record.top = this.top(3);
    this.calls.fill(0);
    this.ms.fill(0);
    this.draws = 0;
    this.discMs = 0;
    this.discBytes = 0;
    this.flight[FLIGHT_DRAWS] = 0;
    this.flight[FLIGHT_PHASE] = CORE;
    this.cycleStart = end;
    this.bridgeEntered = bridge?.entered ?? null;
    return record;
  }

  private top(count: number): [string, number, number][] {
    return METHODS.map((name, i) => [name, this.calls[i]!, this.ms[i]!] as [string, number, number])
      .filter(([, calls]) => calls > 0).sort((a, b) => b[2] - a[2]).slice(0, count)
      .map(([name, calls, ms]) => [name, calls, round(ms)]);
  }

  /** Session totals per method, for the report: only methods that were called. */
  totals(): MethodTotals {
    const table = (source: Bucket): Record<string, MethodTotal> => Object.fromEntries(METHODS.flatMap(
      (name, i): [string, MethodTotal][] => source.calls[i] ? [[name, { calls: source.calls[i]!, ms: round(source.ms[i]!) }]] : []));
    const longest = Object.fromEntries(METHODS.flatMap((name, i): [string, { ms: number; retrace: number }][] =>
      this.longestMs[i] ? [[name, { ms: round(this.longestMs[i]!), retrace: this.longestAt[i]! }]] : []));
    return { all: table(this.all), in_match: table(this.inMatch), longest };
  }
}

type Methods = Record<string, unknown>;

/** Replace `target[name]` with a timed call of the same method on the same object. */
function meterMethod(target: object, name: string, method: string, meter: FrameMeter,
  wrap?: (result: object) => void): void {
  const api = target as Methods;
  const original = api[name];
  if (typeof original !== 'function') {
    if (!meter.notes.includes(`${method} absent: not metered`)) meter.notes.push(`${method} absent: not metered`);
    return;
  }
  const id = METHOD_ID.get(method);
  if (id === undefined) throw new Error(`${method} is not in METHODS`);
  const call = original as Function;
  api[name] = function metered(this: unknown): unknown {
    const started = meter.enter(id);
    let result: unknown;
    // No catch: an exception is the renderer's to handle (gx_webgpu.cpp records it); the meter only
    // makes sure its own state is put back.
    try { result = call.apply(this, arguments); } finally { meter.leave(id, started); }
    if (wrap && typeof result === 'object' && result !== null) wrap(result);
    return result;
  };
}

/**
 * Time every WebGPU call the backend makes: the device's, the queue's, the canvas context's, and
 * those of the encoders, passes, textures and buffers the device returns. The calls are forwarded
 * unchanged, with the same `this`, arguments, result and exceptions.
 */
export function instrumentGpu(gpu: { device: object; context: object | null }, meter: FrameMeter): void {
  const pass = (target: object): void => {
    for (const name of PASS_METHODS) meterMethod(target, name, `pass.${name}`, meter);
  };
  const encoder = (target: object): void => {
    for (const name of ENCODER_METHODS) {
      meterMethod(target, name, `encoder.${name}`, meter, name === 'beginRenderPass' ? pass : undefined);
    }
  };
  const texture = (target: object): void => {
    meterMethod(target, 'createView', 'texture.createView', meter);
    meterMethod(target, 'destroy', 'texture.destroy', meter);
  };
  const buffer = (target: object): void => meterMethod(target, 'destroy', 'buffer.destroy', meter);
  const results: Partial<Record<(typeof DEVICE_METHODS)[number], (result: object) => void>> = {
    createCommandEncoder: encoder, createTexture: texture, createBuffer: buffer,
  };
  for (const name of DEVICE_METHODS) meterMethod(gpu.device, name, `device.${name}`, meter, results[name]);
  const queue = (gpu.device as { queue?: object }).queue;
  if (queue) for (const name of QUEUE_METHODS) {
    // A WebIDL getter may return a fresh JS wrapper. Cover the native prototype, preserving
    // the receiver, rather than relying on the identity of one device.queue read.
    const prototype = Object.getPrototypeOf(queue) as Methods | null;
    const target = prototype && typeof prototype[name] === 'function' ? prototype : queue;
    try { meterMethod(target, name, `queue.${name}`, meter); }
    catch (error) { meter.notes.push(`queue.${name} hook failed: ${error}`); }
  }
  else meter.notes.push('device.queue absent: queue calls not metered');
  if (gpu.context) meterMethod(gpu.context, 'getCurrentTexture', 'context.getCurrentTexture', meter);
}

/**
 * Time the core's disc reads: WORKERFS's `stream_ops.read`, which every node of the mounted disc
 * shares, so patching the one object covers every file. A null return means it is in place; a string
 * says why it is not, and the run goes on unmetered for the disc.
 */
export function meterDiscReads(filesystems: Record<string, unknown>, meter: FrameMeter): string | null {
  const ops = (filesystems['WORKERFS'] as { stream_ops?: Methods } | undefined)?.stream_ops;
  const original = ops?.['read'];
  if (!ops || typeof original !== 'function') return 'WORKERFS.stream_ops.read not found: disc reads are not metered';
  const read = original as Function;
  ops['read'] = function meteredRead(this: unknown): unknown {
    const started = meter.enterDisc();
    let bytes: unknown = 0;
    try { bytes = read.apply(this, arguments); } finally { meter.leaveDisc(started, typeof bytes === 'number' ? bytes : 0); }
    return bytes;
  };
  return null;
}

/** The part of Emscripten's FS a tail needs. */
export interface TailFs {
  stat(path: string): { size: number };
  open(path: string, flags: string): unknown;
  read(stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number): number;
}

/**
 * The lines a core CSV gained since the last call, header dropped. The core appends one row per
 * retrace and flushes it before the retrace beat (native/headless_host.cpp, record_sim_time), so at
 * the beat the row of the retrace that just completed is there. Reads only the new bytes.
 */
export class CsvTail {
  private stream: unknown = null;
  private offset = 0;
  private rest = '';
  private header = true;
  private readonly decoder = new TextDecoder();

  constructor(private readonly fs: TailFs, readonly path: string) {}

  lines(): string[] {
    const size = this.fs.stat(this.path).size;
    if (size <= this.offset) return [];
    if (this.stream === null) this.stream = this.fs.open(this.path, 'r');
    const bytes = new Uint8Array(size - this.offset);
    const read = this.fs.read(this.stream, bytes, 0, bytes.length, this.offset);
    this.offset += read;
    const lines = (this.rest + this.decoder.decode(bytes.subarray(0, read))).split('\n');
    this.rest = lines.pop() ?? '';
    if (this.header && lines.length) { lines.shift(); this.header = false; }
    return lines.filter((line) => line !== '');
  }
}

/** `retrace`'s match_frame in sim_times lines (`retrace,sim_ms,match_frame`), or null if absent. */
export function matchFrameOf(lines: readonly string[], retrace: number): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const cells = lines[i]!.split(',');
    if (Number(cells[0]) !== retrace) continue;
    const value = Number(cells[2]);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
}

/** `retrace`'s decode / non-decode split in decoder_cost lines (columns 7 and 9), or null. */
export function coreSplitOf(lines: readonly string[], retrace: number): CoreSplit | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const cells = lines[i]!.split(',');
    if (Number(cells[0]) !== retrace) continue;
    const decodeMs = Number(cells[7]), nonDecodeMs = Number(cells[9]);
    return Number.isFinite(decodeMs) && Number.isFinite(nonDecodeMs) ? { decodeMs, nonDecodeMs } : null;
  }
  return null;
}

export interface QueueProbe {
  expected: Record<string, number>;
  observed: Record<string, MethodTotal>;
  passed: boolean;
  error: string | null;
}

/** Real, pre-game submission. Every operation rereads device.queue, like the renderer does.
 * Counts/times are reported separately; start() discards this work from gameplay totals.
 */
export async function verifyQueueHooks(device: object, meter: FrameMeter): Promise<QueueProbe> {
  const expected = { 'queue.writeBuffer': 1, 'queue.writeTexture': 1, 'queue.submit': 1 };
  const before = meter.methodSnapshot();
  const api = device as {
    createBuffer(desc: object): { destroy(): void };
    createTexture(desc: object): { destroy(): void };
    createCommandEncoder(): { finish(): unknown };
    queue: {
      writeBuffer(buffer: object, offset: number, data: Uint8Array): void;
      writeTexture(destination: object, data: Uint8Array, layout: object, size: number[]): void;
      submit(commands: unknown[]): void;
      onSubmittedWorkDone(): Promise<void>;
    };
    pushErrorScope(filter: string): void;
    popErrorScope(): Promise<{ message: string } | null>;
  };
  let buffer: { destroy(): void } | undefined, texture: { destroy(): void } | undefined;
  let error: string | null = null;
  let scoped = false;
  try {
    api.pushErrorScope('validation');
    scoped = true;
    buffer = api.createBuffer({ size: 4, usage: 8 }); // COPY_DST
    texture = api.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 2 }); // COPY_DST
    api.queue.writeBuffer(buffer, 0, new Uint8Array(4));
    api.queue.writeTexture({ texture }, new Uint8Array(4), {}, [1, 1]);
    api.queue.submit([api.createCommandEncoder().finish()]);
    await api.queue.onSubmittedWorkDone();
  } catch (cause) { error = String(cause); }
  finally {
    if (scoped) {
      try { const validation = await api.popErrorScope(); if (validation) error = validation.message; }
      catch (cause) { error = String(cause); }
    }
    buffer?.destroy();
    texture?.destroy();
  }
  const after = meter.methodSnapshot();
  const observed = Object.fromEntries(Object.keys(expected).map((name) => [name, {
    calls: after[name]!.calls - before[name]!.calls, ms: after[name]!.ms - before[name]!.ms,
  }]));
  const passed = error === null && Object.entries(expected).every(([name, count]) => observed[name]!.calls === count);
  if (!passed) meter.notes.push(`Queue hook probe failed: ${error ?? 'unexpected call counts'}; queue timings are incomplete`);
  return { expected, observed, passed, error };
}
