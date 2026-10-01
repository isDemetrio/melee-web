import { compareTraces, simTimeStats } from './compare';
import { DiscCache } from './disc-cache.js';
import { chooseDisc, type DiscChoice } from './disc-source.js';
import { opfsDiscStoreFactory } from './opfs-store.js';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = element('status');
const run = element<HTMLButtonElement>('run');
const download = element<HTMLAnchorElement>('download');
const parameters = new URLSearchParams(location.search);
const frames = Number(parameters.get('frames') ?? 2400);
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
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  status.textContent = 'running…';
  /** From the worker's start to the core being callable: reported by worker.ts. */
  let coreLoadMs: number | null = null;
  const stop = () => { worker.terminate(); run.disabled = false; };
  worker.onerror = event => { status.textContent = `error: ${event.message}`; stop(); };
  worker.onmessage = async ({ data }) => {
    if (data.type === 'log') element('log').textContent += `${data.line}\n`;
    if (data.type === 'core') {
      element('core').textContent = `core loaded: ${data.commit} ${data.opt}`;
      coreLoadMs = typeof data.coreLoadMs === 'number' ? data.coreLoadMs : null;
    }
    if (data.type === 'error') { status.textContent = `error: ${data.message}`; stop(); }
    if (data.type !== 'done') return;
    worker.terminate();
    status.textContent = `exit ${data.exitCode}`;
    if (typeof data.coreLoadMs === 'number') coreLoadMs = data.coreLoadMs;
    let statsAll = null, statsInMatch = null, comparison = null;
    // Preserve raw evidence even when an early exit or malformed reference prevents analysis.
    const errors: string[] = [];
    if (data.simTimes) {
      try { statsAll = simTimeStats(data.simTimes, false); } catch (error) { errors.push(String(error)); }
      try { statsInMatch = simTimeStats(data.simTimes, true); } catch (error) { errors.push(String(error)); }
    }
    element('stats').textContent = JSON.stringify({ all: statsAll, in_match: statsInMatch, errors }, null, 2);
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
      sim_times_csv: data.simTimes, stats_all: statsAll, stats_in_match: statsInMatch, comparison };
    resultURL = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    download.href = resultURL;
    download.download = `spike-result-${created.replaceAll(':', '-')}.json`;
    download.hidden = false;
    run.disabled = false;
  };
  worker.postMessage({ iso: file, frames });
};
