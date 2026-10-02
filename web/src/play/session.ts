import { DiscCache } from '../spike/disc-cache.js';
import { opfsDiscStoreFactory } from '../spike/opfs-store.js';
import { InputController } from '../input/controller.js';
import { neutralPad, padStatusBytes } from '../input/pad.js';
import type { TouchControls } from '../input/touch.js';
import { createSharedPad, PRESENTED, publishPad } from './shared-pad.js';

/** One screen owns one worker, download and input publisher. Stop is synchronous and final. */
export class PlaySession {
  private worker: Worker | null = null;
  private readonly abort = new AbortController();
  private closeStore: (() => void) | null = null;
  private input: InputController | null = null;
  private shared: Int32Array | null = null;
  private animation = 0;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly touch: TouchControls,
    private readonly deadzone: number, private readonly status: (text: string) => void,
    private readonly log: (text: string) => void) {}

  async start(picked: File | null): Promise<void> {
    try {
      if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        throw new Error('Live play requires cross-origin isolation and SharedArrayBuffer.');
      }
      const presenter = this.canvas.getContext('bitmaprenderer');
      if (!presenter) throw new Error('ImageBitmap presentation is unavailable.');
      let iso = picked;
      if (!iso) {
        this.status('Checking / downloading the verified disc cache…');
        const store = opfsDiscStoreFactory();
        this.closeStore = () => store.close();
        iso = await new DiscCache(store).downloadDisc({ signal: this.abort.signal,
          onProgress: (p) => this.status(`Disc: ${Math.floor(p.receivedBytes / p.totalBytes * 100)}% verified`),
        });
        store.close();
        this.closeStore = null;
      }
      if (this.disposed) return;
      this.shared = createSharedPad();
      this.input = new InputController({ deadzone: this.deadzone }, undefined, this.touch);
      this.input.attach(window);
      const poll = (): void => {
        this.publish();
        this.animation = requestAnimationFrame(poll);
      };
      poll();
      window.addEventListener('blur', this.release);
      document.addEventListener('visibilitychange', this.visibility);
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
            presenter.transferFromImageBitmap(bitmap);
            Atomics.store(this.shared!, PRESENTED, message.serial as number);
            Atomics.notify(this.shared!, PRESENTED);
            if (message.serial === 1 || message.serial % 60 === 0) this.status(`Running · ${message.retraces} retraces · ${this.input?.source} · audio unavailable`);
          } catch (error) {
            bitmap.close();
            this.fail(`Presentation failed: ${String(error)}`);
          }
        } else if (message.type === 'error') this.fail(String(message.message));
        else if (message.type === 'log') this.log(String(message.line));
        else if (message.type === 'ended') this.fail(`Game ended (code ${message.exitCode}).`);
        else if (message.type === 'ready') this.status('Core ready · starting game…');
      };
      worker.postMessage({ iso, pad: this.shared.buffer });
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
  private readonly visibility = (): void => { if (document.hidden) this.release(); };
  private fail(message: string): void { this.status(message); this.log(message); this.stop(); }
  stop(): void {
    this.disposed = true;
    this.abort.abort();
    this.closeStore?.();
    this.closeStore = null;
    cancelAnimationFrame(this.animation);
    this.input?.detachKeyboard();
    window.removeEventListener('blur', this.release);
    document.removeEventListener('visibilitychange', this.visibility);
    this.worker?.terminate();
    this.worker = null;
  }
}
