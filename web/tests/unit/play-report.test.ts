import { describe, expect, it } from 'vitest';
import { loadHeartbeat, storeHeartbeat } from '../../src/spike/heartbeat';
import { COLUMN, createFlight, FLIGHT_CALL, FLIGHT_DRAWS, FLIGHT_FRAME, FLIGHT_MATCH, FLIGHT_PHASE, FRAME_COLUMNS,
  METHODS, PHASES, type FrameColumn, type FrameRecord, type MethodTotals } from '../../src/play/frame-meter';
import { FREEZE_MS, motive, NOT_MEASURED, PLAY_STORAGE_KEY, PlayReport, type PerfMeta } from '../../src/play/report';

/** A frame record from named cells; every other cell 0, the split columns null. */
function row(cells: Partial<Record<FrameColumn, number>>, top?: FrameRecord['top']): FrameRecord {
  const values = FRAME_COLUMNS.map((name): number | null =>
    cells[name] ?? (name === 'decode_ms' || name === 'non_decode_ms' ? null : 0));
  return top ? { row: values, top } : { row: values };
}
/** A normal frame: 16.7 ms, of which 10 core (6 WebGPU), 0.5 bitmap, 1 ack, 5.2 idle. */
const normal = (retrace: number, matchFrame = 0): FrameRecord => row({ retrace, match_frame: matchFrame, cycle_ms: 16.7,
  core_ms: 10, webgpu_ms: 6, webgpu_calls: 2283, draws: 1874, encode_ms: 4, queue_ms: 2, bitmap_ms: 0.5, ack_ms: 1, idle_ms: 5.2 });
const totals: MethodTotals = { all: { 'queue.submit': { calls: 2, ms: 3 } }, in_match: {}, longest: {} };
const meta: PerfMeta = { commit: 'abc', opt: '-Oz', timerResolutionMs: 0.02, clockCostNs: 40, split: false, notes: ['a note'],
  crossOriginIsolated: true };

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); } };
}

describe('slow frame motive', () => {
  it('names the largest part, and the WebGPU methods inside it', () => {
    const slow = row({ cycle_ms: 80, core_ms: 75, webgpu_ms: 70, pipelines_created: 2, bitmap_ms: 1, ack_ms: 4 },
      [['device.createRenderPipeline', 2, 65], ['queue.submit', 1, 3]]);
    expect(motive(slow.row, slow.top ?? null, false)).toBe('WebGPU calls 70.0 of 80.0 ms ' +
      '(device.createRenderPipeline x2 65.0 ms, queue.submit x1 3.0 ms); 2 render pipeline(s) created');
  });
  it('says when the page, not the worker, held the frame', () => {
    expect(motive(row({ cycle_ms: 60, core_ms: 5, ack_ms: 55 }).row, null, false))
      .toBe('waiting for the page to present 55.0 of 60.0 ms');
  });
  it('splits the core when the profiler ran', () => {
    const split = row({ cycle_ms: 60, core_ms: 58, webgpu_ms: 2, decode_ms: 40, non_decode_ms: 18, disc_ms: 1, disc_bytes: 4096 });
    expect(motive(split.row, null, true)).toBe('core outside WebGPU and disc (simulation + renderer code) 55.0 of 60.0 ms ' +
      '(decode 40.0, non-decode 18.0 ms); 4096 disc bytes read');
  });
});

describe('play report', () => {
  it('summarises where the time went, in the spike\'s statistics, menus and match apart', () => {
    const report = new PlayReport(false, 0);
    report.onMeta(meta);
    const slow = row({ retrace: 3, match_frame: 2, cycle_ms: 120, core_ms: 119, webgpu_ms: 100, queue_ms: 100 },
      [['queue.submit', 1, 100]]);
    report.onBatch({ rows: [normal(1), normal(2, 1), slow, normal(4, 3)], totals, notes: ['meter note'],
      sim: ['1,4.0,0', '2,4.5,1', '3,5.0,2', '4,4.0,3'], decoder: [] });
    const built = report.build(0, 'test agent');
    expect(built.schema).toBe('melee-play-report/1');
    expect(built.frames_total).toBe(4);
    expect(built.core_commit).toBe('abc');
    expect(built.summary.all?.frames).toBe(4);
    expect(built.summary.in_match?.frames).toBe(3);
    expect(built.summary.in_match?.per_frame['cycle_ms']).toMatchObject({ count: 3, max_ms: 120, rows: 'in-match' });
    expect(built.summary.in_match?.percent_of_time).toMatchObject({ webgpu: round1(112 / 153.4 * 100) });
    expect(built.summary.all?.frames_over_ms['50']).toBe(1);
    expect(built.summary.all?.estimated_meter_ms).toBeCloseTo((2 * (3 * 2283 / 4) * 40) / 1e6, 3);
    expect(built.slow_frames.total).toBe(1);
    expect(built.slow_frames.kept[0]).toMatchObject({ retrace: 3, match_frame: 2, cycle_ms: 120 });
    expect(built.slow_frames.kept[0]!.motive).toMatch(/^WebGPU calls 100\.0 of 120\.0 ms \(queue\.submit x1/);
    expect(built.stats_in_match).toMatchObject({ count: 3, max_ms: 5 });
    expect(built.webgpu_methods).toEqual(totals);
    expect(built.notes).toEqual(['a note', 'meter note']);
    expect(built.not_measured).toBe(NOT_MEASURED);
    expect(built.decoder_cost).toBeNull();
    expect(built.errors).toEqual([]);
    const csv = built.frames_csv.split('\n');
    expect(csv[0]).toBe(FRAME_COLUMNS.join(','));
    expect(csv).toHaveLength(5);
    expect(csv[3]!.split(',')[COLUMN.cycle_ms]).toBe('120');
    expect(csv[3]!.split(',')[COLUMN.decode_ms]).toBe('');
  });

  it('leaves hidden frames out of the summary and the slow frames', () => {
    const report = new PlayReport(false, 0);
    report.onBatch({ rows: [normal(1), row({ retrace: 2, cycle_ms: 5000, ack_ms: 5000, hidden: 1 })], totals, notes: [],
      sim: [], decoder: [] });
    const built = report.build(0, 'test agent');
    expect(built.summary.all?.frames).toBe(1);
    expect(built.slow_frames.total).toBe(0);
    expect(built.frames_kept).toBe(2);
    expect(built.stats_all).toBeNull();
  });

  it('shows the last second of frames in its live line', () => {
    const report = new PlayReport(false, 0);
    report.onBatch({ rows: [normal(1), normal(2, 5)], totals, notes: [], sim: [], decoder: [] });
    expect(report.line(0)).toBe('frame 2 (match) · 60 fps, 16.7 ms/frame = core 10.0 (WebGPU 6.0 in 2283 calls, 1874 draws) ' +
      '+ bitmap 0.5 + page 1.0 + idle 5.2 · slow frames 0 · freezes 0');
  });
});

describe('freezes', () => {
  const webgpu = PHASES.indexOf('webgpu');
  const submit = METHODS.indexOf('queue.submit');

  it('records the frame it froze in, how long, and what the worker was doing', () => {
    const report = new PlayReport(false, 0);
    const flight = createFlight();
    report.sample(flight, 0, true);
    flight[FLIGHT_FRAME] = 5;
    flight[FLIGHT_MATCH] = 1;
    report.sample(flight, 1000, true);
    flight[FLIGHT_PHASE] = webgpu;
    flight[FLIGHT_CALL] = submit;
    flight[FLIGHT_DRAWS] = 40;
    report.sample(flight, 1000 + FREEZE_MS - 1, true);
    expect(report.freezesTotal).toBe(0);
    report.sample(flight, 1000 + FREEZE_MS + 50, true);
    expect(report.line(0)).toBe('FROZEN in frame 6 for 0.3 s (40 draws so far), mostly: webgpu queue.submit');
    flight[FLIGHT_FRAME] = 6;
    report.sample(flight, 1400, true);
    const built = report.build(1400, 'test agent');
    expect(built.freezes).toEqual({ total: 1, kept: [{ stuck_in_frame: 6, in_match: true, at_s: 1, duration_ms: 400,
      ongoing: false, draws_so_far: 40, samples: { 'webgpu queue.submit': 1 } }] });
    expect(built.sampled_phases.all.samples).toBe(4);
    expect(built.sampled_phases.in_match.percent).toEqual({ 'webgpu queue.submit': 75, boot: 25 });
  });

  it('does not call a hidden page, or the boot before the first frame, a freeze', () => {
    const report = new PlayReport(false, 0);
    const flight = createFlight();
    report.sample(flight, 0, true);
    report.sample(flight, 5000, true);
    flight[FLIGHT_FRAME] = 1;
    report.sample(flight, 5001, true);
    report.sample(flight, 9000, false);
    report.sample(flight, 9001, true);
    report.sample(flight, 9002, true);
    expect(report.freezesTotal).toBe(0);
  });

  it('closes an open freeze when the session ends, and stops sampling', () => {
    const report = new PlayReport(false, 0);
    const flight = createFlight();
    flight[FLIGHT_FRAME] = 2;
    report.sample(flight, 0, true);
    report.sample(flight, 600, true);
    report.end('Worker failed: boom', 900);
    report.sample(flight, 5000, true);
    const built = report.build(5000, 'test agent');
    expect(built.state).toBe('Worker failed: boom');
    expect(built.freezes.kept[0]).toMatchObject({ stuck_in_frame: 3, duration_ms: 900, ongoing: false });
  });
});

describe('persisted record', () => {
  it('is the spike\'s heartbeat record under the play key, with the frame summary', () => {
    const report = new PlayReport(true, 0);
    report.onMeta({ ...meta, split: true });
    report.onBatch({ rows: [row({ retrace: 1, cycle_ms: 16, core_ms: 16, decode_ms: 9, non_decode_ms: 7 })], totals,
      notes: [], sim: [], decoder: [] });
    report.onLog('scene: major 02 minor 02 (frame 1395)');
    const storage = memoryStorage();
    expect(storeHeartbeat(storage, report.stored(0), PLAY_STORAGE_KEY)).toBeNull();
    expect(loadHeartbeat(storage)).toBeNull();
    const loaded = loadHeartbeat(storage, PLAY_STORAGE_KEY);
    if (!loaded || typeof loaded === 'string') throw new Error(`not loaded: ${loaded}`);
    expect(loaded).toMatchObject({ schema: 'melee-spike-heartbeat/1', core: 'abc', canvas: true,
      logTail: ['scene: major 02 minor 02 (frame 1395)'] });
    expect(loaded.perf).toMatchObject({ schema: 'melee-play-perf/1', state: 'running', frames_total: 1, core_split: true,
      last_600_frames: { frames: 1, core_split_percent_of_time: { decode: 56.3, non_decode: 43.8 } } });
  });
});

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
