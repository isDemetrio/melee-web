import { compareTraces, simTimeStats } from './compare';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = element('status');
const run = element<HTMLButtonElement>('run');
const download = element<HTMLAnchorElement>('download');
const parameters = new URLSearchParams(location.search);
const frames = Number(parameters.get('frames') ?? 2400);
let resultURL: string | undefined;
function controlled(): boolean {
  if (!navigator.serviceWorker?.controller) return false;
  status.textContent = 'a service worker controls this page: use a private window';
  return true;
}
controlled();
run.onclick = () => {
  if (controlled()) return;
  const file = element<HTMLInputElement>('iso').files?.[0];
  const reference = element<HTMLInputElement>('reference').files?.[0];
  if (!file) { status.textContent = 'select a disc image'; return; }
  if (!Number.isSafeInteger(frames) || frames <= 0) { status.textContent = 'invalid frames'; return; }
  if (!parameters.has('nosizecheck') && file.size !== 1459978240) {
    status.textContent = `refused: disc image is ${file.size} bytes, expected 1459978240`; return;
  }
  if (resultURL) URL.revokeObjectURL(resultURL);
  download.hidden = true;
  for (const id of ['core', 'log', 'stats', 'compare']) element(id).textContent = '';
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  run.disabled = true;
  status.textContent = 'running…';
  const stop = () => { worker.terminate(); run.disabled = false; };
  worker.onerror = event => { status.textContent = `error: ${event.message}`; stop(); };
  worker.onmessage = async ({ data }) => {
    if (data.type === 'log') element('log').textContent += `${data.line}\n`;
    if (data.type === 'core') element('core').textContent = `core loaded: ${data.commit} ${data.opt}`;
    if (data.type === 'error') { status.textContent = `error: ${data.message}`; stop(); }
    if (data.type !== 'done') return;
    worker.terminate();
    status.textContent = `exit ${data.exitCode}`;
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
      timer_resolution_ms: data.timerResolutionMs, frames, iso_bytes: file.size, exit_code: data.exitCode,
      final_scene: data.finalScene, wall_ms: data.wallMs, trace_csv: data.trace, sim_times_csv: data.simTimes,
      stats_all: statsAll, stats_in_match: statsInMatch, comparison };
    resultURL = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    download.href = resultURL;
    download.download = `spike-result-${created.replaceAll(':', '-')}.json`;
    download.hidden = false;
    run.disabled = false;
  };
  worker.postMessage({ iso: file, frames });
};
