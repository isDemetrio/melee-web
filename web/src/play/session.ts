import { DiscCache } from '../spike/disc-cache.js';
import { opfsDiscStoreFactory } from '../spike/opfs-store.js';
import { InputController } from '../input/controller.js';
import { neutralPad, padStatusBytes } from '../input/pad.js';
import type { TouchControls } from '../input/touch.js';
import { storeHeartbeat } from '../spike/heartbeat.js';
import { createFlight, FLIGHT_HIDDEN, FLIGHT_RESOLUTION } from './frame-meter.js';
import { RecipeStore } from './pipelines.js';
import { PLAY_STORAGE_KEY, type PlayReport } from './report.js';
import { createSharedPad, PRESENTED, publishPad } from './shared-pad.js';

/** How often the live line is refreshed and the heartbeat record is persisted. */
const PERF_LINE_MS = 1000;
const PERSIST_MS = 2000;

/** The session's measurement: the report it fills, whether to split the core, and its live line. */
export interface PlayPerf {
  report: PlayReport;
  split: boolean;
  /** presentation.ts's mode name: how the worker hands frames over. */
  presentation: string;
  /**
   * resolution.ts's level percent, read on every animation frame: the operator can change the
   * internal resolution during a match and compare levels in one match (session.ts writes it into
   * the flight recorder; the worker applies it to the backend between retraces).
   */
  resolution(): number;
  line(text: string): void;
}

/** One screen owns one worker, download and input publisher. Stop is synchronous and final. */
export class PlaySession {
  private worker: Worker | null = null;
  private readonly abort = new AbortController();
  private closeStore: (() => void) | null = null;
  /** The render pipelines this session compiled in a frame, kept for the next (pipelines.ts). */
  private recipes: RecipeStore | null = null;
  private input: InputController | null = null;
  private shared: Int32Array | null = null;
  private animation = 0;
  private disposed = false;
  /** The worker's flight recorder (frame-meter.ts), read on every animation frame. */
  private readonly flight = createFlight();
  private perfTimer = 0;
  private persistedAt = 0;
  private persistError: string | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly touch: TouchControls,
    private readonly deadzone: number, private readonly status: (text: string) => void,
    private readonly log: (text: string) => void, private readonly perf: PlayPerf) {}

  async start(picked: File | null): Promise<void> {
    try {
      if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        throw new Error('Live play requires cross-origin isolation and SharedArrayBuffer.');
      }
      const presenter = this.canvas.getContext('bitmaprenderer');
      if (!presenter) throw new Error('ImageBitmap presentation is unavailable.');
      let iso = picked;
      // The cache the disc came from: the worker reads it through an OPFS handle (disc-reader.ts).
      let discIdentity: string | null = null;
      if (!iso) {
        this.status('Checking / downloading the verified disc cache…');
        const store = opfsDiscStoreFactory();
        this.closeStore = () => store.close();
        const cache = new DiscCache(store);
        iso = await cache.downloadDisc({ signal: this.abort.signal,
          onProgress: (p) => this.status(`Disc: ${Math.floor(p.receivedBytes / p.totalBytes * 100)}% verified`),
        });
        discIdentity = await cache.cacheId();
        // With the store worker gone no other handle holds the file, so the play worker can open one.
        store.close();
        this.closeStore = null;
      }
      if (this.disposed) return;
      this.shared = createSharedPad();
      this.input = new InputController({ deadzone: this.deadzone }, undefined, this.touch);
      this.input.attach(window);
      const poll = (): void => {
        this.publish();
        // The operator's current level, read live: the worker applies it between retraces.
        Atomics.store(this.flight, FLIGHT_RESOLUTION, this.perf.resolution());
        this.perf.report.sample(this.flight, performance.now(), !document.hidden);
        this.animation = requestAnimationFrame(poll);
      };
      poll();
      window.addEventListener('blur', this.release);
      document.addEventListener('visibilitychange', this.visibility);
      Atomics.store(this.flight, FLIGHT_HIDDEN, document.hidden ? 1 : 0);
      this.perfTimer = window.setInterval(() => this.tick(), PERF_LINE_MS);
      this.status('Loading game core…');
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onerror = (event) => this.fail(`Worker failed: ${event.message}`);
      worker.onmessageerror = () => this.fail('Worker message could not be decoded.');
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data;
        if (message.type === 'frame') {
          const bitmap = message.bitmap as ImageBitmap;
          if (this.disposed) { bitmap.close(); return; }
          try {
            const started = performance.now();
            presenter.transferFromImageBitmap(bitmap);
            this.perf.report.onTransfer(performance.now() - started);
            Atomics.store(this.shared!, PRESENTED, message.serial as number);
            Atomics.notify(this.shared!, PRESENTED);
            if (message.serial === 1 || message.serial % 60 === 0) this.status(`Running · ${message.retraces} retraces · ${this.input?.source} · audio unavailable`);
          } catch (error) {
            bitmap.close();
            this.fail(`Presentation failed: ${String(error)}`);
          }
        } else if (message.type === 'perf') {
          // A WebGPU error is written to the record now, not at the next PERSIST_MS: a page that
          // dies right after it (the bgra-probe crash) would take it along.
          if (this.perf.report.onBatch(message)) this.persist(performance.now());
        }
        else if (message.type === 'beat') this.perf.report.onBeat(message.beat, performance.now());
        else if (message.type === 'perf-meta') {
          this.perf.report.onMeta(message);
          for (const note of message.notes as string[]) this.log(`report: ${note}`);
        } else if (message.type === 'error') this.fail(String(message.message));
        else if (message.type === 'log') {
          this.perf.report.onLog(String(message.line));
          this.log(String(message.line));
        }
        else if (message.type === 'ended') this.fail(`Game ended (code ${message.exitCode}).`);
        else if (message.type === 'ready') this.status('Core ready · starting game…');
        else if (message.type === 'warming') this.status(`Compiling ${message.count} render pipelines…`);
        else if (message.type === 'pipeline') {
          this.recipes ??= new RecipeStore(globalThis.indexedDB, String(message.commit));
          this.recipes.add(message.recipe).catch((error) => this.log(`render pipeline not kept: ${String(error)}`));
        }
      };
      worker.postMessage({ iso, discIdentity, pad: this.shared.buffer, flight: this.flight.buffer, split: this.perf.split,
        presentation: this.perf.presentation, resolution: this.perf.resolution() });
    } catch (error) {
      if (!this.disposed) this.fail(String(error));
      else this.log(`Stopped loading: ${String(error)}`);
    }
  }

  publish(): void {
    if (this.shared && this.input) publishPad(this.shared,
      document.hidden || !document.hasFocus() ? padStatusBytes(neutralPad()) : this.input.pollStatus());
  }
  private readonly release = (): void => {
    this.input?.keyboard.releaseAll();
    if (this.shared) publishPad(this.shared, padStatusBytes(neutralPad()));
  };
  private readonly visibility = (): void => {
    // The worker marks the frames that waited on a hidden page, so they are not called slow.
    Atomics.store(this.flight, FLIGHT_HIDDEN, document.hidden ? 1 : 0);
    if (document.hidden) this.release();
  };
  /** The live line, and the record a killed tab leaves behind (heartbeat.ts), every PERSIST_MS. */
  private tick(): void {
    const now = performance.now();
    this.perf.report.onDisplay({ cssWidth: this.canvas.clientWidth, cssHeight: this.canvas.clientHeight,
      devicePixelRatio: window.devicePixelRatio });
    this.perf.line(this.perf.report.line(now));
    if (now - this.persistedAt >= PERSIST_MS) this.persist(now);
  }
  private persist(now: number): void {
    this.persistedAt = now;
    const error = storeHeartbeat(localStorage, this.perf.report.stored(now), PLAY_STORAGE_KEY);
    // Reported once, not on every tick: the game goes on without the record.
    if (error && error !== this.persistError) this.log(error);
    this.persistError = error;
  }
  private fail(message: string): void { this.status(message); this.log(message); this.stop(message); }
  stop(reason = 'stopped'): void {
    if (!this.disposed) {
      const now = performance.now();
      this.perf.report.end(reason, now);
      window.clearInterval(this.perfTimer);
      this.perf.line(this.perf.report.line(now));
      this.persist(now);
    }
    this.disposed = true;
    this.abort.abort();
    this.closeStore?.();
    this.closeStore = null;
    this.recipes?.close();
    cancelAnimationFrame(this.animation);
    this.input?.detachKeyboard();
    window.removeEventListener('blur', this.release);
    document.removeEventListener('visibilitychange', this.visibility);
    this.worker?.terminate();
    this.worker = null;
  }
}
