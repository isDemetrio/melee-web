import { describe, expect, it } from 'vitest';
import { describeHeartbeat, emptyHeartbeat, heartbeatSender, HISTORY_LIMIT, loadHeartbeat, receiveBeat, storeHeartbeat,
  STORAGE_KEY, type Beat, type RenderProgress, type StoredHeartbeat } from '../../src/spike/heartbeat';

const render: RenderProgress = { draws: 10, copies: 2, texturePool: 5, bindGroupCache: 3, texturesCreated: 9,
  bindGroupsCreated: 4, failure: null };

function sender(intervalMs = 500) {
  let clock = 1000;
  const posted: Beat[] = [];
  const beat = heartbeatSender((b) => posted.push(b), () => clock, () => render, intervalMs);
  return { posted, beat, advance: (ms: number) => { clock += ms; } };
}

describe('heartbeat sender', () => {
  it('posts at most one beat per interval, always the latest frame', () => {
    const { posted, beat, advance } = sender();
    beat(1);
    for (let frame = 2; frame <= 30; frame++) { advance(20); beat(frame); }
    expect(posted.map((b) => b.frame)).toEqual([1, 26]);
    expect(posted[1]).toMatchObject({ frame: 26, frameAtMs: 500, atMs: 500, source: 'retrace', render });
  });
  it('a renderer beat inside a frame keeps the frame and its time', () => {
    const { posted, beat, advance } = sender();
    beat(7);
    advance(3000); beat(-1);
    expect(posted[1]).toMatchObject({ frame: 7, frameAtMs: 0, atMs: 3000, source: 'render' });
  });
  it('nothing is posted while nothing calls it', () => {
    const { posted, beat, advance } = sender();
    beat(1); advance(60_000);
    expect(posted).toHaveLength(1);
  });
});

const beatAt = (frame: number, atMs: number, source: Beat['source'] = 'retrace'): Beat =>
  ({ frame, frameAtMs: atMs, atMs, source, render: null });

describe('heartbeat description', () => {
  it('says none before the first beat', () => {
    expect(describeHeartbeat(emptyHeartbeat(), 0)).toBe('heartbeat: none yet');
  });
  it('tells advancing, stalled in a frame, and silent apart', () => {
    let state = receiveBeat(emptyHeartbeat(), beatAt(1395, 31_000), 100);
    expect(describeHeartbeat(state, 2100)).toMatch(/^heartbeat: frame 1395 at 31\.0 s; last beat 2\.0 s ago$/);
    // The renderer keeps beating but the frame does not move.
    state = receiveBeat(state, { ...beatAt(1395, 31_000), atMs: 45_000, source: 'render', render }, 14_100);
    const stalled = describeHeartbeat(state, 15_100);
    expect(stalled).toContain('STALLED IN FRAME 1396');
    expect(stalled).toContain('no new frame for 15.0 s');
    expect(stalled).toContain('draws 10');
    // Nothing at all.
    expect(describeHeartbeat(state, 30_000)).toContain('SILENT: no beat for 15.9 s');
  });
  it('a new frame resets the stall clock', () => {
    let state = receiveBeat(emptyHeartbeat(), beatAt(10, 100), 0);
    state = receiveBeat(state, beatAt(11, 20_000), 20_000);
    expect(describeHeartbeat(state, 21_000)).toContain('last beat 1.0 s ago');
    expect(state.beats).toBe(2);
    expect(state.history).toEqual([[10, 100], [11, 20_000]]);
  });
  it('caps the history', () => {
    let state = emptyHeartbeat();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) state = receiveBeat(state, beatAt(i, i), i);
    expect(state.history).toHaveLength(HISTORY_LIMIT);
    expect(state.last?.frame).toBe(HISTORY_LIMIT + 4);
  });
});

class MemoryStorage {
  values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error('QuotaExceededError'); this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe('heartbeat persistence', () => {
  const record: StoredHeartbeat = { schema: 'melee-spike-heartbeat/1', startedAt: '2026-10-02T17:00:00.000Z', frames: 2400,
    canvas: true, core: 'abc', last: beatAt(1395, 31_000), receivedAt: '2026-10-02T17:00:31.000Z',
    logTail: ['scene: major 02 minor 02 (frame 1395)'] };
  it('round-trips what a reload needs', () => {
    const storage = new MemoryStorage();
    expect(storeHeartbeat(storage, record)).toBeNull();
    expect(loadHeartbeat(storage)).toEqual(record);
  });
  it('reports a failed write and an unreadable record instead of dropping them', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    expect(storeHeartbeat(storage, record)).toContain('QuotaExceededError');
    storage.failWrites = false;
    expect(loadHeartbeat(storage)).toBeNull();
    storage.setItem(STORAGE_KEY, '{');
    expect(loadHeartbeat(storage)).toMatch(/^stored heartbeat unreadable/);
    storage.setItem(STORAGE_KEY, '{"schema":"other"}');
    expect(loadHeartbeat(storage)).toBe('stored heartbeat has an unknown schema');
  });
});
