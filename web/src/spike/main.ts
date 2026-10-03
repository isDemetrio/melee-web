import type { DecoderCostMode } from './decoder-cost.js';
import { compareTraces, simTimeStats } from './compare';
import { DiscCache } from './disc-cache.js';
import { chooseDisc, type DiscChoice } from './disc-source.js';
import { opfsDiscStoreFactory } from './opfs-store.js';
import { describeHeartbeat, emptyHeartbeat, LOG_TAIL, loadHeartbeat, receiveBeat, storeHeartbeat, STORAGE_KEY,
  type HeartbeatState, type StoredHeartbeat } from './heartbeat.js';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = element('status');
const run = element<HTMLButtonElement>('run');
const download = element<HTMLAnchorElement>('download');
const fetchDisc = element<HTMLButtonElement>('fetch-disc');
const deleteDisc = element<HTMLButtonElement>('delete-disc');
const discStatus = element('disc-status');
const discProgress = element('disc-progress');
const parameters = new URLSearchParams(location.search);
const decoderCost: DecoderCostMode = parameters.get('decoder-cost') === 'legacy' ? 'legacy'
  : parameters.has('decoder-cost') ? 'profile' : 'off';
const frames = Number(parameters.get('frames') ?? 2400);
const screen = element('screen');
const renderOut = element('render');
const heartbeatOut = element('heartbeat');
const partial = element<HTMLButtonElement>('partial');

/** Save `value` as a JSON file now, without keeping a link around. */
function saveJson(value: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * What a run that never finished left behind (heartbeat.ts): shown on load, and saveable as the
 * partial report, until the next run replaces it.
 */
const previous = loadHeartbeat(localStorage);
if (typeof previous === 'string') heartbeatOut.textContent = previous;
else if (previous) {
  heartbeatOut.textContent = `previous run (${previous.startedAt}, ${previous.frames} frames${previous.canvas ? ', canvas' : ''}) ` +
    `never reported: last heartbeat frame ${previous.last?.frame ?? 'none'} at ${previous.receivedAt ?? 'never'}` +
    (previous.last?.render ? `, draws ${previous.last.render.draws}` : '') + `; last log line: ${previous.logTail.at(-1) ?? 'none'}`;
  partial.hidden = false;
  partial.onclick = () => saveJson({ schema: 'melee-spike-partial/1', unfinished: previous },
    `spike-unfinished-${previous.startedAt.replaceAll(':', '-')}.json`);
}

/**
 * A fresh canvas for one worker, or nothing. `?canvas` hands a run's worker an OffscreenCanvas and
 * the core's WebGPU backend draws into it; without it -- the default -- the worker gets no canvas
 * and the run is the headless run it has always been. A canvas can be transferred only once, so
 * every run gets a new one.
 */
function offscreenCanvas(wanted: boolean): OffscreenCanvas | undefined {
  screen.replaceChildren();
  if (!wanted) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  screen.append(canvas);
  return canvas.transferControlToOffscreen();
}

/**
 * `?gx-selftest=AARRGGBB&copies=N`: no disc, no simulation. The worker feeds the core's FIFO decoder
 * N clearing XFB copies of that colour and reads the canvas back (wasm/render/gx_webgpu.cpp,
 * gx_webgpu_selftest). `&target=texture` renders into an offscreen texture instead of a canvas, which
 * is what CI can read back (web/src/spike/gpu.ts says why). `&nocanvas` runs the same commands with
 * no GPU at all, which must not fail. The answer is written into #render as JSON for
 * web/tests/spike/render.spec.ts. `&shaders=specialized` draws with each draw state's generated
 * shader instead of the one shader, and `&cells` reads back a hash of every 80x80 cell of the frame
 * (wasm/render/pixel_pipeline_check.mjs compares the two shaders with them).
 */
const selftestColour = parameters.get('gx-selftest');
if (selftestColour !== null) {
  const argb = Number.parseInt(selftestColour, 16);
  const copies = Number(parameters.get('copies') ?? 2);
  const target = parameters.get('target') === 'texture' ? 'texture' : 'canvas';
  const canvas = offscreenCanvas(target === 'canvas' && !parameters.has('nocanvas'));
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  renderOut.textContent = 'running';
  worker.onerror = (event) => { renderOut.textContent = JSON.stringify({ error: event.message }); };
  worker.onmessage = ({ data }) => {
    if (data.type === 'error') renderOut.textContent = JSON.stringify({ error: data.message });
    if (data.type !== 'selftest') return;
    worker.terminate();
    renderOut.textContent = JSON.stringify({ presented: data.presented, sentinel: data.sentinel, render: data.render });
  };
  const selftest = { argb, copies, repeats: Number(parameters.get('repeats') ?? 1), geometry: Number(parameters.get('geometry') ?? 0), sampleX: Number(parameters.get('sample-x') ?? 320), target: parameters.has('nocanvas') ? undefined : target, resolution: Number(parameters.get('resolution') ?? 100),
    specializedShaders: parameters.get('shaders') === 'specialized', cells: parameters.has('cells') };
  worker.postMessage({ selftest, canvas }, canvas ? [canvas] : []);
}
/**
 * The disc cache, as the page sees it: one `DiscCache` over the OPFS worker. Building it spawns
 * nothing -- the worker is created on the first request -- and every answer it cannot give is
 * handled as "no cached disc" rather than as a failure (disc-source.ts).
 */
const cache = new DiscCache(opfsDiscStoreFactory());
let resultURL: string | undefined;
function controlled(): boolean {
  if (!navigator.serviceWorker?.controller) return false;
  status.textContent = 'a service worker controls this page: use a private window';
  return true;
}
controlled();

/** Bytes with a unit, because the disc is 1.36 GiB and its pieces are 16 MiB. */
function humanBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

/**
 * What the cache holds right now: the whole disc if every piece is stored and hashes to the
 * manifest, otherwise nothing, and what the browser says about persisting the origin's storage.
 *
 * The verified disc is asked for rather than the stored length, because a length is not a
 * disc: `getVerifiedDisc()` re-reads and re-hashes every stored piece and truncates the file at
 * the first one that is wrong, so this line never calls a poisoned cache complete. A manifest the
 * page cannot read -- a local preview with no Function behind it, an HTML sign-in page, a dropped
 * connection -- is reported as an unavailable cache and not as an error, because the selector
 * still runs the page (disc-source.ts, rule 2).
 */
async function refreshDiscStatus(): Promise<void> {
  try {
    const storage = await cache.storageStatus();
    const persisted = storage.persisted ? 'persisted' : 'not persisted';
    const file = await cache.getVerifiedDisc();
    discStatus.textContent = file
      ? `disc cache: ${humanBytes(file.size)} verified, ${persisted}`
      : `disc cache: no verified disc, ${persisted}`;
  } catch (error) {
    discStatus.textContent = `disc cache: unavailable (${error})`;
  }
}
void refreshDiscStatus();

/**
 * Download the missing pieces into OPFS. A second click while one is running joins the download
 * in flight rather than starting a second writer (`disc-cache.ts`), and an interruption leaves
 * the verified prefix behind, so this button is also the resume button.
 */
fetchDisc.onclick = async () => {
  fetchDisc.disabled = true;
  deleteDisc.disabled = true;
  discProgress.textContent = 'disc download: starting…';
  try {
    const file = await cache.downloadDisc({
      onProgress: (progress) => {
        const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
        discProgress.textContent = `disc download: ${humanBytes(progress.receivedBytes)} of ` +
          `${humanBytes(progress.totalBytes)} (${percent}%), piece ${progress.chunkIndex + 1} of ` +
          `${progress.chunkCount}`;
      },
    });
    discProgress.textContent = `disc download: complete, ${humanBytes(file.size)} as ${file.name}`;
  } catch (error) {
    discProgress.textContent = `disc download failed: ${error}`;
  } finally {
    fetchDisc.disabled = false;
    deleteDisc.disabled = false;
    await refreshDiscStatus();
  }
};

/**
 * Delete the cached disc, stopping a download in flight first. The bytes are gone from OPFS, not
 * just forgotten by this page, so the next download starts at offset 0 and the next run falls
 * back to the selector until it finishes.
 */
deleteDisc.onclick = async () => {
  fetchDisc.disabled = true;
  deleteDisc.disabled = true;
  discProgress.textContent = 'disc cache: deleting…';
  try {
    await cache.deleteDisc();
    discProgress.textContent = 'disc cache: deleted';
  } catch (error) {
    discProgress.textContent = `disc cache: deletion failed: ${error}`;
  } finally {
    fetchDisc.disabled = false;
    deleteDisc.disabled = false;
    await refreshDiscStatus();
  }
};

run.onclick = async () => {
  if (controlled()) return;
  const picked = element<HTMLInputElement>('iso').files?.[0] ?? null;
  const reference = element<HTMLInputElement>('reference').files?.[0];
  if (!Number.isSafeInteger(frames) || frames <= 0) { status.textContent = 'invalid frames'; return; }
  run.disabled = true;
  // The verified cached disc comes first; the selector is the fallback. A cache that cannot
  // answer -- no manifest, a dead worker, a page where the manifest should be -- lands on the
  // selector, because a page that cannot use a cache it does not need is a page that cannot run.
  status.textContent = 'looking for a cached disc…';
  let choice: DiscChoice | null;
  try {
    choice = await chooseDisc(cache, picked);
  } catch (error) {
    status.textContent = `error: ${error}`;
    run.disabled = false;
    return;
  }
  if (!choice) { status.textContent = 'select a disc image'; run.disabled = false; return; }
  const file = choice.file;
  const discSource = choice.source;
  const storagePersisted = choice.storagePersisted;
  if (!parameters.has('nosizecheck') && file.size !== 1459978240) {
    status.textContent = `refused: disc image is ${file.size} bytes, expected 1459978240`; run.disabled = false; return;
  }
  if (resultURL) URL.revokeObjectURL(resultURL);
  download.hidden = true;
  for (const id of ['core', 'log', 'stats', 'compare']) element(id).textContent = '';
  const canvas = offscreenCanvas(parameters.has('canvas'));
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  status.textContent = 'running…';
  /** From the worker's start to the core being callable: reported by worker.ts. */
  let coreLoadMs: number | null = null;
  let coreCommit: string | null = null;
  // The heartbeat: kept here, shown every second, persisted on every beat so a reload still has it.
  let heartbeat: HeartbeatState = emptyHeartbeat();
  const logLines: string[] = [];
  const startedAt = new Date().toISOString();
  const stored = (): StoredHeartbeat => ({ schema: 'melee-spike-heartbeat/1', startedAt, frames, canvas: canvas !== undefined,
    core: coreCommit, last: heartbeat.last, receivedAt: heartbeat.receivedAt === null ? null : new Date().toISOString(),
    logTail: logLines.slice(-LOG_TAIL) });
  const persist = () => {
    const error = storeHeartbeat(localStorage, stored());
    if (error && !logLines.includes(error)) { logLines.push(error); element('log').textContent += `${error}\n`; }
  };
  persist();
  const shown = setInterval(() => { heartbeatOut.textContent = describeHeartbeat(heartbeat, performance.now()); }, 1000);
  partial.hidden = false;
  partial.onclick = () => saveJson({ schema: 'melee-spike-partial/1', created: new Date().toISOString(), frames,
    user_agent: navigator.userAgent, core_commit: coreCommit, heartbeat_line: describeHeartbeat(heartbeat, performance.now()),
    heartbeat, log: logLines }, `spike-partial-${new Date().toISOString().replaceAll(':', '-')}.json`);
  /** The run ended, one way or the other: the stored record is no longer an unfinished run. */
  const ended = () => {
    clearInterval(shown);
    heartbeatOut.textContent = describeHeartbeat(heartbeat, performance.now());
    partial.hidden = true;
    localStorage.removeItem(STORAGE_KEY);
  };
  const stop = () => { worker.terminate(); run.disabled = false; ended(); };
  worker.onerror = event => { status.textContent = `error: ${event.message}`; stop(); };
  worker.onmessage = async ({ data }) => {
    if (data.type === 'log') { element('log').textContent += `${data.line}\n`; logLines.push(data.line); persist(); }
    if (data.type === 'beat') { heartbeat = receiveBeat(heartbeat, data.beat, performance.now()); persist(); }
    if (data.type === 'core') {
      coreCommit = data.commit;
      element('core').textContent = `core loaded: ${data.commit} ${data.opt}`;
      coreLoadMs = typeof data.coreLoadMs === 'number' ? data.coreLoadMs : null;
    }
    if (data.type === 'error') { status.textContent = `error: ${data.message}`; stop(); }
    if (data.type !== 'done') return;
    worker.terminate();
    ended();
    status.textContent = `exit ${data.exitCode}`;
    if (typeof data.coreLoadMs === 'number') coreLoadMs = data.coreLoadMs;
    let statsAll = null, statsInMatch = null, comparison = null;
    // Preserve raw evidence even when an early exit or malformed reference prevents analysis.
    const errors: string[] = [];
    if (data.simTimes) {
      try { statsAll = simTimeStats(data.simTimes, false); } catch (error) { errors.push(String(error)); }
      try { statsInMatch = simTimeStats(data.simTimes, true); } catch (error) { errors.push(String(error)); }
    }
    element('stats').textContent = JSON.stringify({ all: statsAll, in_match: statsInMatch, errors,
      decoder_cost: data.decoderCost ? { ...data.decoderCost, csv: undefined } : undefined }, null, 2);
    if (reference) {
      try {
        comparison = compareTraces(await reference.text(), data.trace);
        element('compare').textContent = comparison.identical ? `identical: ${comparison.leftRows} retraces`
          : comparison.first ? `DIFFERENT: first retrace ${comparison.first.retrace} column ${comparison.first.column}`
            : `DIFFERENT: row counts ${comparison.leftRows} vs ${comparison.rightRows}`;
      } catch (error) { element('compare').textContent = `comparison error: ${error}`; }
    }
    const created = new Date().toISOString();
    const result = { schema: 'melee-spike-result/1', created, core_commit: data.coreCommit, core_opt: data.coreOpt,
      user_agent: navigator.userAgent, cross_origin_isolated: data.crossOriginIsolated,
      timer_resolution_ms: data.timerResolutionMs, frames, iso_bytes: file.size,
      disc_source: discSource, storage_persisted: storagePersisted, core_load_ms: coreLoadMs,
      exit_code: data.exitCode, final_scene: data.finalScene, wall_ms: data.wallMs, trace_csv: data.trace,
      decoder_cost: data.decoderCost,
      sim_times_csv: data.simTimes, stats_all: statsAll, stats_in_match: statsInMatch, comparison,
      // The beats as the page received them: frame against worker time, to read a slowdown from.
      heartbeat: { beats: heartbeat.beats, last: heartbeat.last, history: heartbeat.history },
      // Only a ?canvas run has a renderer to report on; a headless result keeps its old shape.
      ...(data.render ? { render: data.render } : {}) };
    if (data.render) renderOut.textContent = JSON.stringify(data.render, null, 2);
    resultURL = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    download.href = resultURL;
    download.download = `spike-result-${created.replaceAll(':', '-')}.json`;
    download.hidden = false;
    run.disabled = false;
  };
  worker.postMessage({ iso: file, frames, canvas, decoderCost }, canvas ? [canvas] : []);
};
