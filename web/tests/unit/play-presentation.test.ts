import { describe, expect, it } from 'vitest';
import { COLUMN, createFlight, FRAME_COLUMNS, FrameMeter, type FrameColumn, type FrameRecord } from '../../src/play/frame-meter';
import { ALTERNATE_BLOCK, offeredModes, PRESENT_DIRECT, PRESENT_LATE, PRESENT_LATE_FIRST, presentationMode, Presenter, PROBE_EVERY,
  PROBE_FORMATS, PROBE_SIZES, TransferProbe, type PresentGpu } from '../../src/play/presentation';
import { alternatePairs, BLOCK_MIN_FRAMES, BLOCK_SETTLE, presentationSummary } from '../../src/play/report';

/**
 * A device and a canvas that write down what reaches the queue, in order, plus the renderer's side
 * of an XFB copy as gx_webgpu.cpp's gxw_copy does it: read `gpu.xfb` (twice, as the EM_JS does),
 * copy the EFB there or to the canvas's current texture, then `gpu.flush()`.
 */
function fakeGpu() {
  const log: string[] = [];
  let textures = 0, canvasFrames = 0;
  const texture = (name: string) => ({ name, width: 640, height: 480, createView: () => `${name} view` });
  let current = texture('canvas#0');
  const encoder = () => {
    const recorded: string[] = [];
    return {
      copyTextureToTexture(source: { texture: { name: string } }, destination: { texture: { name: string } }) {
        recorded.push(`${source.texture.name}->${destination.texture.name}`);
      },
      beginRenderPass() { return { end() { /* fake */ } }; },
      finish: () => recorded,
    };
  };
  let batch: string[] = [];
  const gpu: PresentGpu = {
    device: {
      createTexture: () => texture(`xfb${textures++}`),
      createCommandEncoder: encoder as never,
      queue: { submit: (buffers: unknown[]) => { for (const b of buffers) log.push(`submit ${(b as string[]).join(',')}`); } },
    },
    context: {
      configure() { /* fake */ },
      getCurrentTexture: () => current,
    },
    xfb: null, format: 'rgba8unorm',
    flush: () => { log.push(`submit ${['draws', ...batch].join(',')}`); batch = []; },
  };
  const canvas = {
    transferToImageBitmap: () => {
      log.push(`transfer ${current.name}`);
      current = texture(`canvas#${++canvasFrames}`);
      return { close() { /* fake */ } } as unknown as ImageBitmap;
    },
  };
  /** One retrace with one XFB copy. */
  const xfbCopy = (): void => {
    const target = gpu.xfb ? gpu.xfb : gpu.context!.getCurrentTexture();
    batch.push(`efb->${(target as unknown as { name: string }).name}`);
    gpu.flush!();
  };
  return { gpu, canvas, log, xfbCopy };
}

describe('presentation modes', () => {
  it('reads a mode by name, and anything else is direct', () => {
    expect(presentationMode('bgra-alternate')).toMatchObject({ format: 'bgra8unorm', schedule: 'alternate' });
    expect(presentationMode(undefined)).toMatchObject({ name: 'direct', format: 'rgba8unorm', schedule: 'direct' });
    expect(presentationMode('nonsense').name).toBe('direct');
  });
  it('lists the probe only to a page opened with ?probe (the bgra-probe crash)', () => {
    expect(offeredModes('').map((mode) => mode.name)).toEqual(['direct', 'alternate', 'bgra', 'bgra-alternate']);
    expect(offeredModes('?disc=x').map((mode) => mode.name)).not.toContain('bgra-probe');
    expect(offeredModes('?probe').map((mode) => mode.name)).toEqual(
      ['direct', 'probe', 'alternate', 'bgra', 'bgra-probe', 'bgra-alternate']);
  });
});

describe('presenter', () => {
  it('direct: touches nothing of the renderer, one transfer per retrace', () => {
    const { gpu, canvas, log, xfbCopy } = fakeGpu();
    const flush = gpu.flush;
    const presenter = new Presenter(gpu, canvas, 'direct');
    presenter.install();
    expect(gpu.flush).toBe(flush);
    xfbCopy();
    expect(presenter.present().mode).toBe(PRESENT_DIRECT);
    expect(log).toEqual(['submit draws,efb->canvas#0', 'transfer canvas#0']);
  });

  it('alternate: a late block shows the previous frame, copied before the current frame is submitted', () => {
    const { gpu, canvas, log, xfbCopy } = fakeGpu();
    const presenter = new Presenter(gpu, canvas, 'alternate');
    presenter.install();
    const modes: number[] = [];
    for (let i = 0; i < ALTERNATE_BLOCK; i++) { xfbCopy(); modes.push(presenter.present().mode); }
    expect(new Set(modes)).toEqual(new Set([PRESENT_DIRECT]));
    log.length = 0;
    // First late frame: nothing earlier to show, so this frame's texture goes to the canvas at once.
    xfbCopy();
    expect(presenter.present().mode).toBe(PRESENT_LATE_FIRST);
    // Then each frame's canvas copy of the frame before precedes the frame's own submit.
    xfbCopy();
    expect(presenter.present().mode).toBe(PRESENT_LATE);
    xfbCopy();
    expect(presenter.present().mode).toBe(PRESENT_LATE);
    expect(log).toEqual([
      'submit draws,efb->xfb0', 'submit xfb0->canvas#240', 'transfer canvas#240',
      'submit xfb0->canvas#241', 'submit draws,efb->xfb1', 'transfer canvas#241',
      'submit xfb1->canvas#242', 'submit draws,efb->xfb0', 'transfer canvas#242',
    ]);
    for (let i = 3; i < ALTERNATE_BLOCK; i++) { xfbCopy(); presenter.present(); }
    // Back to direct: the renderer copies to the canvas again.
    log.length = 0;
    xfbCopy();
    expect(presenter.present().mode).toBe(PRESENT_DIRECT);
    expect(log).toEqual([`submit draws,efb->canvas#${2 * ALTERNATE_BLOCK}`, `transfer canvas#${2 * ALTERNATE_BLOCK}`]);
  });

  it('alternate: a retrace without an XFB copy transfers without copying', () => {
    const { gpu, canvas, log, xfbCopy } = fakeGpu();
    const presenter = new Presenter(gpu, canvas, 'alternate');
    presenter.install();
    for (let i = 0; i < ALTERNATE_BLOCK; i++) { xfbCopy(); presenter.present(); }
    xfbCopy(); presenter.present();
    log.length = 0;
    expect(presenter.present().mode).toBe(PRESENT_LATE);
    expect(log).toEqual([`transfer canvas#${ALTERNATE_BLOCK + 1}`]);
    // A flush that is not an XFB copy (a full arena) copies nothing to the canvas.
    log.length = 0;
    gpu.flush!();
    expect(log).toEqual(['submit draws']);
  });
});

describe('transfer probe', () => {
  it('probes every PROBE_EVERY frames, in turn on every size and format, outside the metered calls', () => {
    const configured: string[] = [];
    const transfers: string[] = [];
    let closed = 0, submits = 0, clock = 0;
    const makeCanvas = (width: number, height: number) => {
      let format = '';
      return {
        getContext: () => ({
          configure: (c: { format: string }) => { format = c.format; configured.push(`${width}x${height} ${c.format}`); },
          getCurrentTexture: () => ({ width, height, createView: () => 'view' }),
        }),
        transferToImageBitmap: () => { transfers.push(`${width}x${height} ${format}`); clock += 3; return { close: () => { closed++; } } as unknown as ImageBitmap; },
      };
    };
    const encoder = { beginRenderPass: () => ({ end() { /* fake */ } }), copyTextureToTexture() { /* fake */ }, finish: () => 'commands' };
    const probe = new TransferProbe(() => encoder, () => { submits++; clock += 1; }, {}, makeCanvas, () => clock);
    expect(configured).toHaveLength(PROBE_SIZES.length * PROBE_FORMATS.length);
    const results = Array.from({ length: 2 * PROBE_EVERY * configured.length }, () => probe.run());
    const ran = results.filter((r) => r !== null);
    expect(ran).toHaveLength(2 * configured.length);
    expect(results[0]).toBeNull();
    expect(ran[0]).toEqual({ transferMs: 3, px: 320 * 240, bgra: false });
    expect(ran[1]).toEqual({ transferMs: 3, px: 320 * 240, bgra: true });
    expect(transfers.slice(0, configured.length)).toEqual(configured);
    expect([closed, submits]).toEqual([ran.length, ran.length]);
  });
});

describe('frame meter with a probe', () => {
  it('cuts the probe out of idle, and leaves idle alone without one', () => {
    let clock = 0;
    const meter = new FrameMeter(createFlight(), () => clock);
    meter.start();
    const cycle = (probe: boolean): FrameRecord => {
      clock += 10; meter.coreEnd(1, 1, null);
      clock += 4; meter.bitmapDone(PRESENT_LATE);
      clock += 1; meter.ackDone();
      meter.probeStart();
      if (probe) clock += 2;
      meter.probeDone(probe ? { transferMs: 1.5, px: 307200, bgra: true } : null);
      clock += 3;
      return meter.cycleEnd();
    };
    const with_ = cycle(true), without = cycle(false);
    const get = (record: FrameRecord, column: FrameColumn) => record.row[COLUMN[column]];
    expect(with_.row).toHaveLength(FRAME_COLUMNS.length);
    expect([get(with_, 'present_mode'), get(with_, 'probe_ms'), get(with_, 'probe_transfer_ms'), get(with_, 'probe_px'),
      get(with_, 'probe_bgra'), get(with_, 'idle_ms'), get(with_, 'cycle_ms')]).toEqual([1, 2, 1.5, 307200, 1, 3, 20]);
    expect([get(without, 'probe_ms'), get(without, 'probe_px'), get(without, 'idle_ms'), get(without, 'cycle_ms')])
      .toEqual([null, null, 3, 18]);
  });
});

/** A visible in-match row from named cells; the probe columns null unless given. */
function row(cells: Partial<Record<FrameColumn, number>>): (number | null)[] {
  return FRAME_COLUMNS.map((name): number | null => cells[name] ??
    (name.startsWith('probe_') || name === 'decode_ms' || name === 'non_decode_ms' ? null : 0));
}

describe('presentation summary', () => {
  it('pairs each direct block with the late block after it, without the settling frames', () => {
    const rows: (number | null)[][] = [];
    let retrace = 0;
    const block = (late: boolean, bitmap: number, frames = BLOCK_MIN_FRAMES + BLOCK_SETTLE) => {
      for (let i = 0; i < frames; i++) {
        // The settling frames are wild on purpose: they must not reach the means.
        const settling = i < BLOCK_SETTLE;
        rows.push(row({ retrace: ++retrace, match_frame: retrace, present_mode: late ? (i === 0 ? 2 : 1) : 0,
          bitmap_ms: settling ? 100 : bitmap, cycle_ms: settling ? 100 : 15 + bitmap }));
      }
    };
    block(true, 1); // a late block first has no direct block before it
    block(false, 10); block(true, 4);
    block(false, 9); block(true, 3);
    block(false, 10, BLOCK_MIN_FRAMES); // too short to pair
    block(true, 2);
    const pairs = alternatePairs(rows)!;
    expect(pairs.pairs).toBe(2);
    expect(pairs.difference['bitmap_ms']).toMatchObject({ late_minus_direct_ms: -6, sd_ms: 0, standard_error_ms: 0 });
    expect(pairs.difference['cycle_ms']!.late_minus_direct_ms).toBe(-6);
  });

  it('tables the probe by size and format, and counts transferred against shown pixels', () => {
    const rows = [
      row({ retrace: 1, match_frame: 1, bitmap_ms: 9, probe_ms: 2, probe_transfer_ms: 1, probe_px: 307200, probe_bgra: 0 }),
      row({ retrace: 2, match_frame: 2, bitmap_ms: 11 }),
      row({ retrace: 3, match_frame: 3, bitmap_ms: 9, probe_ms: 1, probe_transfer_ms: 0.5, probe_px: 307200, probe_bgra: 1 }),
      row({ retrace: 4, match_frame: 4, bitmap_ms: 13 }),
    ];
    const summary = presentationSummary(rows, 'probe', { cssWidth: 390, cssHeight: 320, devicePixelRatio: 3 });
    expect(summary.probe_transfer_ms).toEqual({
      '307200 px rgba8unorm': { count: 1, mean: 1, p50: 1, p95: 1 },
      '307200 px bgra8unorm': { count: 1, mean: 0.5, p50: 0.5, p95: 0.5 },
    });
    expect(summary.after_probe?.bitmap_ms).toMatchObject({ count: 2, mean: 12 });
    expect(summary.pixels).toMatchObject({ transferred: 307200, shown_device_px: 1170 * 960,
      transferred_over_shown: Math.round(307200 / (1170 * 960) * 1000) / 1000 });
    expect(summary.alternate_pairs).toBeNull();
  });
});
