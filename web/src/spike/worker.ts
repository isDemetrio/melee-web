// P0-10 spike worker: loads the offline core once, runs one simulation synchronously, and
// posts back the checkpoint trace and per-retrace simulation times. One run per Worker.
interface CoreFS {
  mkdir(path: string): void;
  writeFile(path: string, data: string): void;
  readFile(path: string, options: { encoding: 'utf8' }): string;
  mount(type: unknown, options: { files: File[] }, mountpoint: string): void;
  filesystems: Record<string, unknown>;
}
interface MeleeCore { FS: CoreFS; callMain(args: string[]): number }
type CoreFactory = (options: { print(line: string): void; printErr(line: string): void }) => Promise<MeleeCore>;

const CORE = '/spike-core/';
const scope = self as unknown as DedicatedWorkerGlobalScope;
const lines: string[] = [];
const log = (line: string): void => { lines.push(line); scope.postMessage({ type: 'log', line }); };

/** Smallest observable step of performance.now(): the resolution every sim_ms is quantised to. */
function timerResolutionMs(): number {
  let best = Number.POSITIVE_INFINITY;
  let last = performance.now();
  for (let i = 0; i < 200_000; i++) {
    const now = performance.now();
    if (now > last) { best = Math.min(best, now - last); last = now; }
  }
  return best;
}

scope.onmessage = async (event: MessageEvent<{ iso: File; frames: number }>) => {
  const { iso, frames } = event.data;
  try {
    const head = await fetch(`${CORE}melee_core_web.js`, { method: 'HEAD' });
    const type = head.headers.get('content-type') ?? '';
    if (!head.ok || !type.includes('javascript')) {
      throw new Error(`no core at ${CORE} (HTTP ${head.status}, ${type}); it is built only by phase0-build.yml`);
    }
    const meta = (await (await fetch(`${CORE}core.json`)).json()) as { commit: string; opt: string };
    const script = await (await fetch(`${CORE}parity_vs_onett.txt`)).text();
    const factory = ((await import(/* @vite-ignore */ `${CORE}melee_core_web.js`)) as { default: CoreFactory }).default;
    const resolution = timerResolutionMs();
    const core = await factory({ print: log, printErr: log });
    scope.postMessage({ type: 'core', commit: meta.commit, opt: meta.opt });
    const fs = core.FS;
    fs.mkdir('/disc');
    fs.mount(fs.filesystems['WORKERFS'], { files: [iso] }, '/disc');
    fs.mkdir('/work');
    fs.mkdir('/work/card');
    fs.writeFile('/work/script.txt', script);
    // The same arguments as scripts/phase0/run_checkpoints.sh, so traces compare one to one.
    const args = ['--iso', `/disc/${iso.name}`, '--headless', '--fast', '--frames', String(frames),
      '--time-base', '1', '--volume', '0', '--script', '/work/script.txt', '--card-dir', '/work/card',
      '--state-trace', '/work/trace.csv', '--sim-times', '/work/sim_times.csv'];
    const started = performance.now();
    const exitCode = core.callMain(args);
    const wallMs = performance.now() - started;
    const read = (path: string): string => { try { return fs.readFile(path, { encoding: 'utf8' }); } catch { return ''; } };
    scope.postMessage({
      type: 'done', exitCode, wallMs, coreCommit: meta.commit, coreOpt: meta.opt,
      timerResolutionMs: resolution, crossOriginIsolated: scope.crossOriginIsolated,
      finalScene: lines.find((line) => line.startsWith('final scene:')) ?? null,
      trace: read('/work/trace.csv'), simTimes: read('/work/sim_times.csv'),
    });
  } catch (error) {
    scope.postMessage({ type: 'error', message: String(error) });
  }
};
