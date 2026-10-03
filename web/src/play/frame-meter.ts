/**
 * The play worker's per-frame meter (web/src/play/worker.ts): where one frame's wall time goes,
 * measured in the worker, on the worker's clock, without touching the core or `wasm/render/`.
 *
 * A frame is one cycle of the worker, from the end of one retrace's presentation to the end of the
 * next one's. It is cut into four consecutive parts by five clock reads, so they add up to the cycle
 * exactly:
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

export const PHASES = ['boot', 'core', 'webgpu', 'disc', 'bitmap', 'ack', 'idle'] as const;
export type Phase = (typeof PHASES)[number];
const BOOT = 0, CORE = 1, WEBGPU = 2, DISC = 3, BITMAP = 4, ACK = 5, IDLE = 6;

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
  'bitmap_ms', 'ack_ms', 'idle_ms', 'hidden', 'decode_ms', 'non_decode_ms'] as const;
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
export interface CoreSplit { decodeMs: number; nonDecodeMs: number }

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
  private resume = BOOT;
  private draws = 0;
  private discMs = 0;
  private discBytes = 0;
  private retrace = 0;
  private matchFrame: number | null = null;
  private split: CoreSplit | null = null;
  private hidden = false;

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
  coreEnd(retrace: number, matchFrame: number | null, split: CoreSplit | null): void {
    this.coreEndAt = this.now();
    this.retrace = retrace;
    this.matchFrame = matchFrame;
    this.split = split;
    this.hidden = this.flight[FLIGHT_HIDDEN] !== 0;
    this.flight[FLIGHT_FRAME] = retrace;
    this.flight[FLIGHT_MATCH] = matchFrame !== null && matchFrame > 0 ? 1 : 0;
    this.flight[FLIGHT_PHASE] = BITMAP;
  }

  bitmapDone(): void {
    this.bitmapEndAt = this.now();
    this.flight[FLIGHT_PHASE] = ACK;
  }

  ackDone(): void {
    this.ackEndAt = this.now();
    // A hidden page does not present, so a frame that waited for it is not a slow frame.
    this.hidden ||= this.flight[FLIGHT_HIDDEN] !== 0;
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
    const values: Record<FrameColumn, number | null> = {
      retrace: this.retrace, match_frame: this.matchFrame, cycle_ms: round(cycle),
      core_ms: round(this.coreEndAt - this.cycleStart), webgpu_ms: round(webgpuMs), webgpu_calls: calls,
      draws: this.draws, resources_ms: round(category.resources), encode_ms: round(category.encode),
      queue_ms: round(category.queue), present_ms: round(category.present), created,
      pipelines_created: this.calls[PIPELINE]!, disc_ms: round(this.discMs), disc_bytes: this.discBytes,
      bitmap_ms: round(this.bitmapEndAt - this.coreEndAt), ack_ms: round(this.ackEndAt - this.bitmapEndAt),
      idle_ms: round(end - this.ackEndAt), hidden: this.hidden ? 1 : 0,
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
  api[name] = function metered(): unknown {
    const started = meter.enter(id);
    let result: unknown;
    // No catch: an exception is the renderer's to handle (gx_webgpu.cpp records it); the meter only
    // makes sure its own state is put back.
    try { result = call.apply(target, arguments); } finally { meter.leave(id, started); }
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
  if (queue) for (const name of QUEUE_METHODS) meterMethod(queue, name, `queue.${name}`, meter);
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
