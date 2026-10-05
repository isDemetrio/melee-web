/**
 * The play page's report: what the operator sends from the phone after a match, in the spike's form
 * (web/src/spike/main.ts, `melee-spike-result/1`) -- the same per-column statistics (`simTimeStats`:
 * count, mean, p95, p99, max, nearest-rank), the same `stats_all` / `stats_in_match` from the core's
 * sim_times rows, the same heartbeat record and, with the core split on, the same `decoder_cost`
 * summary -- plus what only a live game has: where each frame's time went (frame-meter.ts), the slow
 * frames with their motive, and the freezes the page saw while the worker was not moving.
 *
 * Nothing here touches the DOM or the clock: the session hands it `now` (performance.now()), so the
 * whole report is unit-testable.
 */
import { nearestRank, simTimeStats } from '../spike/compare.js';
import { DECODER_COST_HEADER, decoderCostReport } from '../spike/decoder-cost.js';
import { describeHeartbeat, emptyHeartbeat, LOG_TAIL, receiveBeat, type Beat, type HeartbeatState,
  type StoredHeartbeat } from '../spike/heartbeat.js';
import { COLUMN, FLIGHT_CALL, FLIGHT_DRAWS, FLIGHT_FRAME, FLIGHT_MATCH, FLIGHT_PHASE, FRAME_COLUMNS, METHODS,
  PHASES, SLOW_FRAME_MS, type FrameColumn, type FrameRecord, type MethodTotals, type QueueProbe } from './frame-meter.js';

/** localStorage key of the play page's heartbeat record; the spike's stays apart. */
export const PLAY_STORAGE_KEY = 'melee-play-heartbeat';
/** Frame rows kept for the report: the last ten minutes at 60 Hz. Totals cover the whole session. */
export const ROWS_KEPT = 36_000;
/** Frame rows in the stored record: the last two seconds at 60 Hz, as long as the page waits between writes. */
export const STORED_ROWS = 120;
/** No new frame for this long, with the page visible, is a freeze. */
export const FREEZE_MS = 250;
export const SLOW_FRAMES_KEPT = 200;
export const FREEZES_KEPT = 200;
const LOG_KEPT = 200;
/** What `--frames` the play worker passes: the session has no end of its own. */
const UNBOUNDED_FRAMES = 4294967295;

/** What the report cannot see. Written into every report, so the numbers are read with their limits. */
export const NOT_MEASURED = [
  'GPU-process and GPU time after a WebGPU call returns: webgpu_ms is only the synchronous part of each call. On WebKit every call is an IPC message to the GPU process; its Metal encoding and the GPU execution are invisible here, except where a later synchronous call (queue.submit, context.getCurrentTexture, transferToImageBitmap in bitmap_ms) has to wait for them.',
  'GPU completion: the worker never yields while the game runs, so onSubmittedWorkDone and timestamp queries cannot resolve. There is no GPU time in this report.',
  'Simulation against drawing inside core_ms, unless core_split is true: without it, core_ms - webgpu_ms - disc_ms is the simulation and the renderer\'s own JavaScript and C++ together. With it, decode_ms / non_decode_ms come from the core\'s profiler, whose clock reads add time to core_ms.',
  'Garbage collection: a pause lands in whichever part was running and is not named.',
  'Calls shorter than timer_resolution_ms read as 0 or one tick; the per-method totals are sums of such reads.',
  'The meter\'s own cost is inside core_ms: about 2 x webgpu_calls x clock_cost_ns per frame (estimated_meter_ms in the summary).',
  'When a presented frame reaches the screen: ack_ms ends when the page has handed the bitmap to its canvas, not when the compositor shows it.',
  'Residual timing now adds five JS clock reads and two steady_clock reads per retrace (previously three and one). estimated_residual_clock_ms retains the old four-read JS proxy for compatibility; estimated_total_residual_clock_ms uses separate startup JS/native calibrations. Neither estimates wrapper work, scheduling or profiler reads; neither is subtracted.',
  'core_ms = sim_ms + previous_heartbeat_tail_ms + csv_write_ms + heartbeat_read_ms + heartbeat_finish_ms + core_unattributed_ms. Signed residual is not clamped; absent/mismatched core telemetry and the first frame have null residual. WebGPU/disc are overlapping submeasurements, not additional phases.',
  'Residual attribution uses same-retrace native roundtrip versus JS callback elapsed time, including ACK/pacing waits. These overlap existing phases and must not be added to the cycle. previous_js_return_to_resume_probe_ms ends at the last JS probe before native resume; previous_bridge_outside_js_ms contains native-to-JS ingress plus probe-to-native-resume, including instrumentation. Wall clocks cannot distinguish GC, descheduling, hidden runtime waits or CPU work inside those boundaries. residual_unexplained_ms retains signed clock/accounting disagreement; no interval is automatically called CPU work or a wait.',
  'WebGPU calls made before the first frame (the backend attaching) are not counted.',
  'sampled_phases and freezes are read on the page\'s animation frames (about 60 Hz, nearest frame): they can alias with the worker, which is also paced at 60 Hz, and they stop while the page\'s main thread is blocked.',
  'Frames while the page was hidden are kept in frames_csv (hidden = 1) but left out of every summary.',
  'What bitmap_ms is made of, in a direct session: the GPU process finishing the frame\'s messages, the GPU finishing the frame, and the transfer itself are one synchronous call (presentation.ts). Only a probe session (the transfer with nothing queued) and an alternate session (direct against one-frame-late blocks) take it apart; see presentation in the report.',
];

export interface PerfMeta {
  queueProbe?: QueueProbe;
  commit: string | null;
  opt: string | null;
  timerResolutionMs: number;
  clockCostNs: number;
  nativeClockCostNs?: number | null;
  split: boolean;
  notes: string[];
  crossOriginIsolated: boolean;
  /** presentation.ts's mode name; absent before the presentation experiments. */
  presentation?: string;
}

/** The page's canvas as the phone shows it, for the transferred / shown pixel ratio. */
export interface Display { cssWidth: number; cssHeight: number; devicePixelRatio: number }

export interface PerfBatch {
  rows: FrameRecord[];
  sim: string[];
  decoder: string[];
  totals: MethodTotals;
  notes: string[];
}

export interface SlowFrame {
  retrace: number;
  match_frame: number | null;
  cycle_ms: number;
  motive: string;
  top: FrameRecord['top'] | null;
  row: (number | null)[];
}

/** A stretch with no new frame, seen from the page through the flight recorder (frame-meter.ts). */
export interface Freeze {
  /** The frame the worker was computing: one past the last completed. */
  stuck_in_frame: number;
  in_match: boolean;
  /** Seconds into the session at which the last frame had completed. */
  at_s: number;
  duration_ms: number;
  ongoing: boolean;
  /** The renderer's draws in the stuck frame, at the last sample. */
  draws_so_far: number;
  /** What the worker was doing at each animation-frame sample: phase, or `webgpu <method>`. */
  samples: Record<string, number>;
}

type Row = (number | null)[];
const value = (row: Row, column: FrameColumn): number => row[COLUMN[column]] ?? 0;
const round = (x: number, places = 3): number => Math.round(x * 10 ** places) / 10 ** places;
function keepLast<T>(list: T[], limit: number): void {
  // In blocks, so a long session does not shift the array on every frame.
  if (list.length > limit + 1000) list.splice(0, list.length - limit);
}
function bump(counts: Map<string, number> | Record<string, number>, key: string): void {
  if (counts instanceof Map) counts.set(key, (counts.get(key) ?? 0) + 1);
  else counts[key] = (counts[key] ?? 0) + 1;
}
function mostSampled(samples: Record<string, number>): string {
  return Object.entries(samples).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'nothing sampled';
}

export function phaseKey(phase: number, call: number): string {
  const name = PHASES[phase] ?? `phase ${phase}`;
  return name === 'webgpu' ? `webgpu ${METHODS[call] ?? `method ${call}`}` : name;
}

/**
 * Why a frame was slow, in one line: its largest part, and what is known about that part. The parts
 * are those of frame-meter.ts; idle is never a motive, it is what is left over.
 */
export function motive(row: Row, top: FrameRecord['top'] | null, split: boolean): string {
  const ms = (column: FrameColumn): number => value(row, column);
  const parts: [string, number][] = [
    ['core outside WebGPU and disc (simulation + renderer code)', ms('core_ms') - ms('webgpu_ms') - ms('disc_ms')],
    ['WebGPU calls', ms('webgpu_ms')],
    ['disc reads', ms('disc_ms')],
    ['transferToImageBitmap', ms('bitmap_ms')],
    ['waiting for the page to present', ms('ack_ms')],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  const [name, largest] = parts[0]!;
  let text = `${name} ${largest.toFixed(1)} of ${ms('cycle_ms').toFixed(1)} ms`;
  if (name === 'WebGPU calls' && top?.length) {
    text += ` (${top.map(([method, calls, time]) => `${method} x${calls} ${time.toFixed(1)} ms`).join(', ')})`;
  }
  if (name.startsWith('core') && split && row[COLUMN.decode_ms] !== null) {
    text += ` (decode ${ms('decode_ms').toFixed(1)}, non-decode ${ms('non_decode_ms').toFixed(1)} ms)`;
  }
  if (ms('pipelines_created')) text += `; ${ms('pipelines_created')} render pipeline(s) created`;
  else if (ms('created')) text += `; ${ms('created')} GPU object(s) created`;
  if (ms('disc_bytes')) text += `; ${ms('disc_bytes')} disc bytes read`;
  return text;
}

const TIMING: FrameColumn[] = ['cycle_ms', 'core_ms', 'webgpu_ms', 'resources_ms', 'encode_ms', 'queue_ms', 'present_ms',
  'disc_ms', 'bitmap_ms', 'ack_ms', 'idle_ms', 'sim_ms', 'previous_heartbeat_tail_ms', 'csv_write_ms',
  'heartbeat_read_ms', 'heartbeat_finish_ms', 'core_unattributed_ms', 'probe_ms', 'probe_transfer_ms'];
const COUNTS: FrameColumn[] = ['webgpu_calls', 'draws', 'created', 'pipelines_created', 'disc_bytes'];
const OVER_MS = [20, 33.4, 50, 100, 250, 1000];

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/** Frames of a block of `alternate` left out of its mean: the boundary frame is shown twice or skipped. */
export const BLOCK_SETTLE = 2;
/** A block with fewer in-match frames than this is not paired: it is the start or the end of a match. */
export const BLOCK_MIN_FRAMES = 60;
const PAIR_COLUMNS: FrameColumn[] = ['cycle_ms', 'core_ms', 'bitmap_ms', 'ack_ms', 'idle_ms'];

/**
 * An alternate session's pairs: each direct block (present_mode 0) with the late block after it
 * (1, its first frame 2). Blocks are cut on all frames, in order, so a menu stretch splits nothing;
 * only their visible in-match frames are averaged, minus BLOCK_SETTLE at the start. The noise is the
 * spread of the pair differences: a difference smaller than two standard errors is not a result.
 */
export function alternatePairs(rows: Row[]) {
  const blocks: { late: boolean; rows: Row[] }[] = [];
  for (const row of rows) {
    const late = value(row, 'present_mode') !== 0;
    const block = blocks.at(-1);
    if (block && block.late === late) block.rows.push(row);
    else blocks.push({ late, rows: [row] });
  }
  const usable = (block: { rows: Row[] }): Row[] => block.rows.slice(BLOCK_SETTLE)
    .filter((row) => value(row, 'hidden') === 0 && value(row, 'match_frame') > 0);
  const pairs: { direct_frames: number; late_frames: number; direct: Record<string, number>; late: Record<string, number> }[] = [];
  for (let i = 0; i + 1 < blocks.length; i++) {
    const a = blocks[i]!, b = blocks[i + 1]!;
    if (a.late || !b.late) continue;
    const direct = usable(a), late = usable(b);
    if (direct.length < BLOCK_MIN_FRAMES || late.length < BLOCK_MIN_FRAMES) continue;
    const means = (selected: Row[]) => Object.fromEntries(PAIR_COLUMNS.map((column) =>
      [column, round(mean(selected.map((row) => value(row, column))))]));
    pairs.push({ direct_frames: direct.length, late_frames: late.length, direct: means(direct), late: means(late) });
  }
  if (!pairs.length) return null;
  const difference = Object.fromEntries(PAIR_COLUMNS.map((column) => {
    const d = pairs.map((pair) => pair.late[column]! - pair.direct[column]!);
    const m = mean(d);
    const sd = d.length > 1 ? Math.sqrt(d.reduce((total, x) => total + (x - m) ** 2, 0) / (d.length - 1)) : null;
    const directMean = mean(pairs.map((pair) => pair.direct[column]!));
    return [column, { late_minus_direct_ms: round(m), sd_ms: sd === null ? null : round(sd),
      standard_error_ms: sd === null ? null : round(sd / Math.sqrt(d.length)),
      relative: directMean ? round(m / directMean, 4) : null }];
  }));
  return { pairs: pairs.length, settle_frames: BLOCK_SETTLE, min_frames: BLOCK_MIN_FRAMES, difference, per_pair: pairs };
}

/**
 * Where the presentation's time goes (presentation.ts): bitmap_ms by how the canvas got its picture,
 * the alternate session's pairs, the probe's transfers by canvas size and format, and how many pixels
 * are transferred against how many the phone shows.
 */
export function presentationSummary(rows: Row[], mode: string | null, display: Display | null) {
  const visible = rows.filter((row) => value(row, 'hidden') === 0);
  const inMatch = visible.filter((row) => value(row, 'match_frame') > 0);
  const selected = inMatch.length ? inMatch : visible;
  const stats = (values: number[]) => values.length ? { count: values.length, mean: round(mean(values)),
    p50: nearestRank(values, 0.5), p95: nearestRank(values, 0.95) } : null;
  const byMode: Record<string, unknown> = {};
  for (const [name, code] of [['direct', 0], ['late', 1], ['late_first', 2]] as const) {
    const these = selected.filter((row) => value(row, 'present_mode') === code);
    if (!these.length) continue;
    byMode[name] = Object.fromEntries(PAIR_COLUMNS.map((column) => [column, stats(these.map((row) => value(row, column)))]));
  }
  const probes: Record<string, unknown> = {};
  const probed = selected.filter((row) => row[COLUMN.probe_transfer_ms] != null);
  for (const px of [...new Set(probed.map((row) => value(row, 'probe_px')))].sort((a, b) => a - b)) {
    for (const bgra of [0, 1]) {
      const these = probed.filter((row) => value(row, 'probe_px') === px && value(row, 'probe_bgra') === bgra);
      if (these.length) probes[`${px} px ${bgra ? 'bgra8unorm' : 'rgba8unorm'}`] = stats(these.map((row) => value(row, 'probe_transfer_ms')));
    }
  }
  // A probe runs after its frame's presentation: the frame after it is the one it can slow down.
  const afterProbe = selected.filter((row, i) => i > 0 && selected[i - 1]![COLUMN.probe_ms] != null &&
    value(selected[i - 1]!, 'retrace') === value(row, 'retrace') - 1);
  const shown = display ? Math.round(display.cssWidth * display.devicePixelRatio) * Math.round(display.cssHeight * display.devicePixelRatio) : null;
  return {
    mode: mode ?? 'direct', frames: inMatch.length ? 'in_match' : 'all',
    by_present_mode: byMode,
    alternate_pairs: alternatePairs(rows),
    probe_transfer_ms: probed.length ? probes : null,
    after_probe: probed.length ? { bitmap_ms: stats(afterProbe.map((row) => value(row, 'bitmap_ms'))),
      cycle_ms: stats(afterProbe.map((row) => value(row, 'cycle_ms'))) } : null,
    pixels: { transferred: 640 * 480, display, shown_device_px: shown,
      transferred_over_shown: shown ? round(640 * 480 / shown) : null },
  };
}

function countStats(values: number[]) {
  const total = values.reduce((a, b) => a + b, 0);
  return { count: values.length, mean: round(total / values.length), p95: nearestRank(values, 0.95),
    max: Math.max(...values), total };
}

/**
 * The summary of a set of visible frames: per-column statistics in the spike's form, the share of
 * the total time each part took, the frame rate, and how many frames were late by how much.
 */
export function summarize(rows: Row[], inMatch: boolean, split: boolean, clockCostNs: number | null, errors: string[], nativeClockCostNs: number | null = null) {
  const visible = rows.filter((row) => value(row, 'hidden') === 0);
  const selected = inMatch ? visible.filter((row) => value(row, 'match_frame') > 0) : visible;
  if (!selected.length) return null;
  const label = inMatch ? 'in_match' : 'all';
  const timing = split ? [...TIMING, 'decode_ms', 'non_decode_ms'] as FrameColumn[] : TIMING;
  const per_frame: Record<string, ReturnType<typeof simTimeStats> | null> = {};
  for (const column of timing) {
    const measured = selected.filter((row) => row[COLUMN[column]] != null);
    if (!measured.length) { per_frame[column] = null; continue; }
    // The spike's statistics, fed the spike's CSV shape: one row per frame, match_frame decides in-match.
    const csv = 'retrace,sim_ms,match_frame\n' + measured.map((row) =>
      `${value(row, 'retrace')},${value(row, column)},${value(row, 'match_frame')}`).join('\n');
    try { per_frame[column] = simTimeStats(csv, inMatch); } catch (error) {
      per_frame[column] = null;
      errors.push(`${label} ${column}: ${error}`);
    }
  }
  const counts = Object.fromEntries(COUNTS.map((column) => [column, countStats(selected.map((row) => value(row, column)))]));
  const sum = (column: FrameColumn): number => selected.reduce((total, row) => total + value(row, column), 0);
  const total = sum('cycle_ms');
  const share = (ms: number): number => (total > 0 ? round((ms / total) * 100, 1) : 0);
  const percent: Record<string, number> = {
    core_outside_webgpu_and_disc: share(sum('core_ms') - sum('webgpu_ms') - sum('disc_ms')),
    webgpu: share(sum('webgpu_ms')), disc: share(sum('disc_ms')), bitmap: share(sum('bitmap_ms')),
    ack: share(sum('ack_ms')), probe: share(sum('probe_ms')), idle: share(sum('idle_ms')),
  };
  const webgpu_percent = { resources: share(sum('resources_ms')), encode: share(sum('encode_ms')),
    queue: share(sum('queue_ms')), present: share(sum('present_ms')) };
  const meanCalls = sum('webgpu_calls') / selected.length;
  const reconciliationColumns: FrameColumn[] = ['cycle_ms', 'core_ms', 'sim_ms', 'previous_heartbeat_tail_ms',
    'csv_write_ms', 'heartbeat_read_ms', 'heartbeat_finish_ms', 'core_unattributed_ms', 'bitmap_ms', 'ack_ms', 'idle_ms'];
  const matched = selected.filter((row) => reconciliationColumns.every((column) => row[COLUMN[column]] != null));
  const absoluteResidual = matched.map((row) => Math.abs(value(row, 'core_unattributed_ms')));
  const reconciliation = {
    matched_frames: matched.length, excluded_frames: selected.length - matched.length,
    mean_ms: matched.length ? Object.fromEntries(reconciliationColumns.map((column) => [column,
      round(matched.reduce((total, row) => total + value(row, column), 0) / matched.length)])) : null,
    unattributed_abs_mean_ms: matched.length ? round(absoluteResidual.reduce((a, b) => a + b, 0) / matched.length) : null,
    unattributed_abs_p95_ms: matched.length ? nearestRank(absoluteResidual, 0.95) : null,
    unattributed_abs_max_ms: matched.length ? Math.max(...absoluteResidual) : null,
  };
  const attributionColumns: FrameColumn[] = ['core_unattributed_ms', 'native_pre_heartbeat_ms',
    'previous_native_roundtrip_ms', 'previous_js_heartbeat_ms', 'previous_js_return_to_resume_probe_ms',
    'previous_bridge_outside_js_ms', 'bridge_entry_ms', 'residual_unexplained_ms'];
  const attributed = selected.filter((row) => attributionColumns.every((column) => row[COLUMN[column]] != null));
  const residualAttribution = {
    matched_frames: attributed.length, excluded_frames: selected.length - attributed.length,
    status: attributed.length ? 'intervals measured; wait versus CPU work inside each interval is not measured'
      : 'unavailable: requires consecutive retraces with native bridge telemetry and both JS return probes',
    mean_ms: attributed.length ? Object.fromEntries(attributionColumns.map((column) => [column,
      round(attributed.reduce((total, row) => total + value(row, column), 0) / attributed.length)])) : null,
    unexplained_abs_p95_ms: attributed.length
      ? nearestRank(attributed.map((row) => Math.abs(value(row, 'residual_unexplained_ms'))), 0.95) : null,
    unexplained_abs_max_ms: attributed.length
      ? Math.max(...attributed.map((row) => Math.abs(value(row, 'residual_unexplained_ms')))) : null,
  };
  return {
    rows: label, frames: selected.length, seconds: round(total / 1000, 1),
    fps: total > 0 ? round(selected.length / (total / 1000), 1) : null,
    percent_of_time: percent, webgpu_percent_of_time: webgpu_percent,
    ...(split ? { core_split_percent_of_time: { decode: share(sum('decode_ms')), non_decode: share(sum('non_decode_ms')) } } : {}),
    frames_over_ms: Object.fromEntries(OVER_MS.map((ms) => [String(ms), selected.filter((row) => value(row, 'cycle_ms') > ms).length])),
    per_frame, counts, reconciliation, residual_attribution: residualAttribution,
    residual_clock_reads: { js: 5, native: 2, added_js: 2, added_native: 1 },
    estimated_total_residual_clock_ms: clockCostNs === null || nativeClockCostNs === null ? null
      : round((5 * clockCostNs + 2 * nativeClockCostNs) / 1e6, 6),
    estimated_added_residual_clock_ms: clockCostNs === null || nativeClockCostNs === null ? null
      : round((2 * clockCostNs + nativeClockCostNs) / 1e6, 6),
    estimated_residual_clock_ms: clockCostNs === null ? null : round(4 * clockCostNs / 1e6, 6),
    estimated_meter_ms: clockCostNs === null ? null : round((2 * meanCalls * clockCostNs) / 1e6),
  };
}

export class PlayReport {
  readonly startedAt = new Date().toISOString();
  meta: PerfMeta | null = null;
  /** 'running' until the session ends; then why it ended. */
  state = 'running';
  framesTotal = 0;
  slowTotal = 0;
  freezesTotal = 0;
  private rows: Row[] = [];
  private slow: SlowFrame[] = [];
  private freezes: Freeze[] = [];
  private open: Freeze | null = null;
  private totals: MethodTotals | null = null;
  private readonly notes: string[] = [];
  private sim: string[] = [];
  private decoder: string[] = [];
  private heartbeat: HeartbeatState = emptyHeartbeat();
  private log: string[] = [];
  private transfers: number[] = [];
  private display: Display | null = null;
  private readonly samples = { all: new Map<string, number>(), in_match: new Map<string, number>() };
  private lastFrame = 0;
  private lastChange: number;

  constructor(readonly requestedSplit: boolean, private readonly t0: number) {
    this.lastChange = t0;
  }

  onMeta(meta: PerfMeta): void {
    this.meta = meta;
    for (const note of meta.notes) this.note(note);
  }

  onBatch(batch: PerfBatch): void {
    const split = this.meta?.split ?? false;
    for (const record of batch.rows) {
      this.rows.push(record.row);
      this.framesTotal++;
      if (value(record.row, 'cycle_ms') >= SLOW_FRAME_MS && value(record.row, 'hidden') === 0) {
        this.slowTotal++;
        this.slow.push({ retrace: value(record.row, 'retrace'), match_frame: record.row[COLUMN.match_frame] ?? null,
          cycle_ms: value(record.row, 'cycle_ms'), motive: motive(record.row, record.top ?? null, split),
          top: record.top ?? null, row: record.row });
      }
    }
    // The worst ones are kept, not the first ones.
    if (this.slow.length > 2 * SLOW_FRAMES_KEPT) this.slow = this.worstSlow(SLOW_FRAMES_KEPT);
    keepLast(this.rows, ROWS_KEPT);
    this.sim.push(...batch.sim);
    keepLast(this.sim, ROWS_KEPT);
    this.decoder.push(...batch.decoder);
    keepLast(this.decoder, ROWS_KEPT);
    this.totals = batch.totals;
    for (const note of batch.notes) this.note(note);
  }

  onBeat(beat: Beat, now: number): void {
    this.heartbeat = receiveBeat(this.heartbeat, beat, now);
  }

  onLog(line: string): void {
    this.log.push(line);
    keepLast(this.log, LOG_KEPT);
  }

  /** The page canvas's size on screen, the last one seen. */
  onDisplay(display: Display): void {
    this.display = display;
  }

  /** How long the page's transferFromImageBitmap took for one frame. */
  onTransfer(ms: number): void {
    this.transfers.push(ms);
    keepLast(this.transfers, ROWS_KEPT);
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  end(reason: string, now: number): void {
    if (this.state !== 'running') return;
    this.closeFreeze(now);
    this.state = reason;
  }

  /**
   * One animation-frame sample of the flight recorder: a phase histogram for the whole session, and
   * freeze detection -- the frame counter not moving for FREEZE_MS while the page is visible.
   */
  sample(flight: Int32Array, now: number, visible: boolean): void {
    if (this.state !== 'running') return;
    const frame = Atomics.load(flight, FLIGHT_FRAME);
    // Before the first frame the core is booting; a hidden page does not present, so nothing moves.
    if (!visible || frame === 0) {
      this.closeFreeze(now);
      this.lastFrame = frame;
      this.lastChange = now;
      return;
    }
    const key = phaseKey(Atomics.load(flight, FLIGHT_PHASE), Atomics.load(flight, FLIGHT_CALL));
    const match = Atomics.load(flight, FLIGHT_MATCH) !== 0;
    bump(this.samples.all, key);
    if (match) bump(this.samples.in_match, key);
    if (frame !== this.lastFrame) {
      this.closeFreeze(now);
      this.lastFrame = frame;
      this.lastChange = now;
      return;
    }
    const still = now - this.lastChange;
    if (still < FREEZE_MS) return;
    if (!this.open) {
      this.open = { stuck_in_frame: frame + 1, in_match: match, at_s: round((this.lastChange - this.t0) / 1000, 2),
        duration_ms: 0, ongoing: true, draws_so_far: 0, samples: {} };
      this.freezesTotal++;
      if (this.freezes.length < FREEZES_KEPT) this.freezes.push(this.open);
    }
    this.open.duration_ms = Math.round(still);
    this.open.draws_so_far = Atomics.load(flight, FLIGHT_DRAWS);
    bump(this.open.samples, key);
  }

  private closeFreeze(now: number): void {
    if (!this.open) return;
    this.open.duration_ms = Math.round(now - this.lastChange);
    this.open.ongoing = false;
    this.open = null;
  }

  private worstSlow(count: number): SlowFrame[] {
    return [...this.slow].sort((a, b) => b.cycle_ms - a.cycle_ms).slice(0, count);
  }

  /** The live line under the game: the last second of frames, or the freeze in progress. */
  line(now: number): string {
    if (this.open) {
      return `FROZEN in frame ${this.open.stuck_in_frame} for ${(this.open.duration_ms / 1000).toFixed(1)} s ` +
        `(${this.open.draws_so_far} draws so far), mostly: ${mostSampled(this.open.samples)}`;
    }
    const recent = this.rows.slice(-60).filter((row) => value(row, 'hidden') === 0);
    const last = recent.at(-1);
    if (!last) return describeHeartbeat(this.heartbeat, now);
    const mean = (column: FrameColumn): number => recent.reduce((total, row) => total + value(row, column), 0) / recent.length;
    const cycle = mean('cycle_ms');
    return `frame ${value(last, 'retrace')}${value(last, 'match_frame') > 0 ? ' (match)' : ''} · ` +
      `${(1000 / cycle).toFixed(0)} fps, ${cycle.toFixed(1)} ms/frame = core ${mean('core_ms').toFixed(1)} ` +
      `(WebGPU ${mean('webgpu_ms').toFixed(1)} in ${mean('webgpu_calls').toFixed(0)} calls, ${mean('draws').toFixed(0)} draws) ` +
      `+ bitmap ${mean('bitmap_ms').toFixed(1)} + page ${mean('ack_ms').toFixed(1)} + idle ${mean('idle_ms').toFixed(1)} · ` +
      `slow frames ${this.slowTotal} · freezes ${this.freezesTotal}`;
  }

  private sampled() {
    const table = (counts: Map<string, number>) => {
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      return { samples: total, percent: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])
        .map(([key, count]) => [key, round((count / total) * 100, 1)])) };
    };
    return { all: table(this.samples.all), in_match: table(this.samples.in_match) };
  }

  /** The report the operator sends: `melee-play-report/1`. */
  build(now: number, userAgent: string) {
    const errors: string[] = [];
    const split = this.meta?.split ?? false;
    const clock = this.meta?.clockCostNs ?? null;
    const rows = this.rows.slice(-ROWS_KEPT);
    const sim = this.sim.slice(-ROWS_KEPT);
    const simCsv = `retrace,sim_ms,match_frame\n${sim.join('\n')}`;
    let statsAll = null, statsInMatch = null;
    if (sim.length) {
      try { statsAll = simTimeStats(simCsv, false); } catch (error) { errors.push(`stats_all: ${error}`); }
      try { statsInMatch = simTimeStats(simCsv, true); } catch (error) { errors.push(`stats_in_match: ${error}`); }
    }
    const transfers = this.transfers.slice(-ROWS_KEPT);
    return {
      schema: 'melee-play-report/1', created: new Date().toISOString(), started_at: this.startedAt, state: this.state,
      core_commit: this.meta?.commit ?? null, core_opt: this.meta?.opt ?? null, user_agent: userAgent,
      cross_origin_isolated: this.meta?.crossOriginIsolated ?? null,
      timer_resolution_ms: this.meta?.timerResolutionMs ?? null, clock_cost_ns: clock,
      native_clock_cost_ns: this.meta?.nativeClockCostNs ?? null,
      core_split: split, core_split_requested: this.requestedSplit,
      frames_total: this.framesTotal, frames_kept: rows.length, slow_frame_ms: SLOW_FRAME_MS, freeze_ms: FREEZE_MS,
      summary: { all: summarize(rows, false, split, clock, errors, this.meta?.nativeClockCostNs ?? null), in_match: summarize(rows, true, split, clock, errors, this.meta?.nativeClockCostNs ?? null) },
      queue_probe: this.meta?.queueProbe ?? null,
      webgpu_methods: this.totals,
      slow_frames: { total: this.slowTotal, kept: this.worstSlow(SLOW_FRAMES_KEPT) },
      freezes: { total: this.freezesTotal, kept: this.freezes },
      sampled_phases: this.sampled(),
      page_transfer_ms: transfers.length ? countStats(transfers) : null,
      presentation: presentationSummary(rows, this.meta?.presentation ?? null, this.display),
      // The spike's own statistics over the core's sim_times rows: sim_ms is the core's measure of core_ms.
      stats_all: statsAll, stats_in_match: statsInMatch,
      decoder_cost: split ? decoderCostReport('profile', true, `${DECODER_COST_HEADER}\n${this.decoder.slice(-ROWS_KEPT).join('\n')}`) : null,
      heartbeat: { line: describeHeartbeat(this.heartbeat, now), beats: this.heartbeat.beats, last: this.heartbeat.last,
        history: this.heartbeat.history },
      notes: this.notes, errors, not_measured: NOT_MEASURED, log_tail: this.log,
      columns: FRAME_COLUMNS, frames_csv: [FRAME_COLUMNS.join(','), ...rows.map((row) => row.map((cell) => cell ?? '').join(','))].join('\n'),
      sim_times_csv: simCsv,
    };
  }

  /**
   * What the page keeps in localStorage while the session runs: the spike's heartbeat record, plus
   * a compact summary, so a tab that is killed mid-match still says where its time was going.
   */
  stored(now: number): StoredHeartbeat {
    const errors: string[] = [];
    const split = this.meta?.split ?? false;
    const received = this.heartbeat.receivedAt;
    return {
      schema: 'melee-spike-heartbeat/1', startedAt: this.startedAt, frames: UNBOUNDED_FRAMES, canvas: true,
      core: this.meta?.commit ?? null, last: this.heartbeat.last,
      receivedAt: received === null ? null : new Date(Date.now() - (now - received)).toISOString(),
      logTail: this.log.slice(-LOG_TAIL),
      perf: {
        schema: 'melee-play-perf/1', state: this.state, line: this.line(now), frames_total: this.framesTotal,
        core_split: split, last_600_frames: summarize(this.rows.slice(-600), false, split, this.meta?.clockCostNs ?? null, errors, this.meta?.nativeClockCostNs ?? null),
        slow_frames: { total: this.slowTotal, worst: this.worstSlow(20) },
        freezes: { total: this.freezesTotal, last: this.freezes.slice(-20) },
        queue_probe: this.meta?.queueProbe ?? null,
      webgpu_methods: this.totals, notes: this.notes, errors,
        // What a session that closed the page was doing in its last seconds (the bgra-probe crash,
        // docs/PRESENTATION_COST.md): the mode, the probe's table so far, and the last frames as
        // they were, probe canvas included.
        presentation: presentationSummary(this.rows.slice(-600), this.meta?.presentation ?? null, this.display),
        last_frames_csv: [FRAME_COLUMNS.join(','),
          ...this.rows.slice(-STORED_ROWS).map((row) => row.map((cell) => cell ?? '').join(','))].join('\n'),
      },
    };
  }
}
