/**
 * The run's heartbeat: how far the simulation got and when, sent while `callMain` is still
 * running, so a run that stops leaves a position behind instead of a frozen page.
 *
 * Why it is needed. A run is one synchronous `callMain` in the worker, and everything it reports --
 * trace, sim times, renderer counts -- is posted when that call returns. The log lines arrive live
 * (worker.ts posts each one as it is printed), but the game prints only at scene changes, so a run
 * that stops between two scene changes, or one that slows to a crawl, looks the same as one that is
 * fine: the operator's iPhone run of 9b08acf stopped after `scene: major 02 minor 02 (frame 1395)`
 * with no report, and whether it was stuck or slow could not be told.
 *
 * Where the beats come from. The simulation calls `Module.heartbeat(retraces)` at the end of every
 * retrace (`wasm/core/heartbeat.cpp`, through `host::retrace_heartbeat`), and the WebGPU backend
 * calls `Module.heartbeat(-1)` for every draw (`wasm/render/gx_webgpu.cpp`): a frame that renders
 * slowly still beats, and a beat whose frame has not moved says the time goes inside that frame.
 * Neither call reads or writes guest state. Posting a message from a worker does not need the
 * worker's task to end, which is how the log lines already reach the page.
 *
 * The page keeps the last beat in `localStorage` too, so a tab that has to be reloaded or killed
 * still says, on the next load, where the run it was showing had got to.
 */

/** What the renderer had done when a beat was taken; null in a run without a backend. */
export interface RenderProgress {
  /** Draws recorded (`gxWebgpu.drawSerial`); they are submitted once per frame, in one batch. */
  draws: number;
  /** XFB copies submitted (`gxWebgpu.backendCopies`). */
  copies: number;
  /** Textures in the backend's pool and bind groups in its cache, when it has them. */
  texturePool: number | null;
  bindGroupCache: number | null;
  /** createTexture / createBindGroup calls that returned, from gpu-resources.ts. */
  texturesCreated: number;
  bindGroupsCreated: number;
  /** Why the backend stopped, if it did (`gxWebgpu.failure`). */
  failure: string | null;
}

export interface Beat {
  /** Retraces completed: the simulation frame the run has reached. 0 before the first one. */
  frame: number;
  /** Worker milliseconds since the simulation started at which `frame` completed. */
  frameAtMs: number;
  /** Worker milliseconds since the simulation started at which this beat was taken. */
  atMs: number;
  /** 'retrace' when a frame completed; 'render' when the backend beat inside a frame. */
  source: 'retrace' | 'render';
  render: RenderProgress | null;
}

/** Smallest interval between two posted beats. A beat is never posted for nothing to report. */
export const BEAT_INTERVAL_MS = 500;

/**
 * The function the core calls (`Module.heartbeat`): `retraces >= 0` when a frame completed, -1 from
 * the renderer. It posts at most one beat per `intervalMs`, always the latest state. Cheap enough to
 * be called for every draw: a comparison, and a clock read.
 */
export function heartbeatSender(post: (beat: Beat) => void, now: () => number,
  render: () => RenderProgress | null, intervalMs = BEAT_INTERVAL_MS): (retraces: number) => void {
  const started = now();
  let frame = 0;
  let frameAtMs = 0;
  let lastPost = Number.NEGATIVE_INFINITY;
  return (retraces: number) => {
    const at = now() - started;
    if (retraces >= 0) { frame = retraces; frameAtMs = at; }
    if (at - lastPost < intervalMs) return;
    lastPost = at;
    post({ frame, frameAtMs: round(frameAtMs), atMs: round(at), source: retraces >= 0 ? 'retrace' : 'render', render: render() });
  };
}

/** What the page knows about a running run, on its own clock. */
export interface HeartbeatState {
  beats: number;
  last: Beat | null;
  /** Page milliseconds at which the last beat arrived, and at which `last.frame` was first seen. */
  receivedAt: number | null;
  frameSeenAt: number | null;
  /** Every beat's (frame, atMs), capped: enough to plot the frame rate of a run that slowed down. */
  history: [frame: number, atMs: number][];
}

export const HISTORY_LIMIT = 4000;

export function emptyHeartbeat(): HeartbeatState {
  return { beats: 0, last: null, receivedAt: null, frameSeenAt: null, history: [] };
}

export function receiveBeat(state: HeartbeatState, beat: Beat, pageNow: number): HeartbeatState {
  const moved = !state.last || state.last.frame !== beat.frame;
  const history = state.history.length < HISTORY_LIMIT ? [...state.history, [beat.frame, beat.atMs] as [number, number]] : state.history;
  return { beats: state.beats + 1, last: beat, receivedAt: pageNow, frameSeenAt: moved ? pageNow : state.frameSeenAt, history };
}

/** No new frame for this long is called stalled. A good run completes a frame every few ms. */
export const STALL_MS = 10_000;

/**
 * One line for the page: where the run is and whether it is moving. Three cases are told apart:
 * frames advancing; beats arriving but the frame not advancing (the time goes inside one frame,
 * and the renderer's counts say whether drawing is progressing); and no beats at all (the worker
 * is blocked in a single call, or gone).
 */
export function describeHeartbeat(state: HeartbeatState, pageNow: number, stallMs = STALL_MS): string {
  const last = state.last;
  if (!last || state.receivedAt === null || state.frameSeenAt === null) return 'heartbeat: none yet';
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  const silent = pageNow - state.receivedAt;
  const still = pageNow - state.frameSeenAt;
  const render = last.render
    ? `, draws ${last.render.draws}, copies ${last.render.copies}, pool ${last.render.texturePool ?? '-'}, ` +
      `textures created ${last.render.texturesCreated}, bind groups created ${last.render.bindGroupsCreated}` +
      (last.render.failure ? `, backend stopped: ${last.render.failure}` : '')
    : '';
  const where = `heartbeat: frame ${last.frame} at ${seconds(last.frameAtMs)}${render}`;
  if (still < stallMs) return `${where}; last beat ${seconds(silent)} ago`;
  if (silent < stallMs) return `${where}; STALLED IN FRAME ${last.frame + 1}: no new frame for ${seconds(still)}, renderer still beating`;
  return `${where}; SILENT: no beat for ${seconds(silent)} (worker blocked in one call, or gone)`;
}

/** What the page persists while a run is going, so a reload still finds it. */
export interface StoredHeartbeat {
  schema: 'melee-spike-heartbeat/1';
  startedAt: string;
  frames: number;
  canvas: boolean;
  core: string | null;
  last: Beat | null;
  receivedAt: string | null;
  /** The last log lines, which is where the scene changes are. */
  logTail: string[];
}

export const STORAGE_KEY = 'melee-spike-heartbeat';
export const LOG_TAIL = 40;

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** A failed write (storage full, disabled) is reported to the caller, not dropped. */
export function storeHeartbeat(storage: StorageLike, record: StoredHeartbeat): string | null {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
    return null;
  } catch (error) {
    return `heartbeat not persisted: ${error}`;
  }
}

/** The record a previous run left, or null; an unreadable one is returned as an error string. */
export function loadHeartbeat(storage: StorageLike): StoredHeartbeat | string | null {
  let text: string | null;
  try { text = storage.getItem(STORAGE_KEY); } catch (error) { return `stored heartbeat unreadable: ${error}`; }
  if (text === null) return null;
  try {
    const record = JSON.parse(text) as StoredHeartbeat;
    return record?.schema === 'melee-spike-heartbeat/1' ? record : `stored heartbeat has an unknown schema`;
  } catch (error) {
    return `stored heartbeat unreadable: ${error}`;
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
