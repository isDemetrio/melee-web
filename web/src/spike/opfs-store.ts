/**
 * The page's side of the disc cache: one OPFS worker, one identified message per operation.
 *
 * `opfs-worker.ts` does the writing, because `createSyncAccessHandle()` exists only in a worker.
 * This module is the other end of that conversation, and the only part of it the rest of the page
 * ever sees: it hands `disc-cache.ts` a `DiscStore` per cache identity, and the download module
 * neither knows nor needs to know that a worker is involved.
 *
 * Three decisions are worth naming, because they are not obvious from the code:
 *
 *  1. **Every request carries an id, and every reply repeats it.** A resume scan and a download
 *     can be in the air at once -- `disc-cache.ts` asks for a length while a previous piece is
 *     still being written -- and a reply without an id could not be told from the other one's.
 *     Two requests answered out of order must land on their own promises, so the id is the whole
 *     matching mechanism: nothing here relies on arrival order.
 *  2. **One worker for every identity.** The worker serialises its own operations anyway, and the
 *     file it guards is one per identity, so a second worker would buy nothing and would take a
 *     second lock on the same file.
 *  3. **A worker error is not one request's failure.** Nothing will answer the requests already
 *     sent, so they are all rejected with the same error and the worker is dropped: the next
 *     request spawns a fresh one rather than waiting forever for an answer that cannot come.
 *
 * The worker is injected, so `web/tests/unit/opfs-store.test.ts` drives this module against a fake
 * worker that runs the *real* request handler from `opfs-worker.ts` over a fake file system.
 */

import type { DiscStore, DiscStoreFactory } from './disc-cache.js';
import type { DiscStoreRequest, DiscStoreReply } from './opfs-worker.js';

/** The worker, as much of it as this module uses. */
export interface DiscStoreWorkerLike {
  postMessage(message: DiscStoreRequest): void;
  addEventListener(type: 'message' | 'error', listener: (event: unknown) => void): void;
  /** Present on a real `Worker`; called when the worker is dropped after a failure. */
  terminate?(): void;
}

export interface OpfsDiscStoreOptions {
  /** How the worker is created. Injected by tests; the browser default spawns the module worker. */
  readonly worker?: () => DiscStoreWorkerLike;
}

/** A `DiscStoreFactory` that owns a worker, so the page can let it go when it is done. */
/**
 * The factory the page builds: a `DiscStoreFactory` whose stores are ready immediately.
 *
 * The synchronous signature comes first on purpose. `DiscStoreFactory` allows a promise, and the
 * intersection keeps that compatibility, but this factory creates nothing but a small object --
 * the worker is spawned on the first message -- so every caller can hold a `DiscStore` without
 * awaiting one. Without it, the callers would have to narrow `DiscStore | Promise<DiscStore>` at
 * every call site for no benefit.
 */
export type OpfsDiscStoreFactory = ((identity: string) => DiscStore) & DiscStoreFactory & {
  /** Stop the worker and reject whatever it had not answered. */
  close(): void;
};

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** One worker, and the requests waiting for it. */
class WorkerClient {
  private worker: DiscStoreWorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly create: () => DiscStoreWorkerLike) {}

  /** A `DiscStore` for one cache identity. */
  store(identity: string): DiscStore {
    return new WorkerDiscStore(this, identity);
  }

  /** Send one operation and wait for its own reply. */
  request(message: Omit<DiscStoreRequest, 'id'>): Promise<unknown> {
    const worker = this.spawn();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...message, id });
      } catch (error) {
        // A worker that cannot be posted to is a worker whose reply will never arrive: the
        // promise must not stay pending on it.
        this.pending.delete(id);
        reject(new Error(`the disc cache worker could not be asked for ${message.op}: ${String(error)}`));
      }
    });
  }

  /** Reject everything in flight and drop the worker. */
  close(reason = 'the disc cache worker was closed'): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    worker?.terminate?.();
    for (const entry of waiting) entry.reject(new Error(reason));
  }

  private spawn(): DiscStoreWorkerLike {
    const existing = this.worker;
    if (existing) return existing;
    const worker = this.create();
    worker.addEventListener('message', (event) => this.receive(event));
    // `error` carries no id, so it cannot be attributed to one request: it fails all of them.
    worker.addEventListener('error', (event) => {
      this.close(`the disc cache worker failed: ${describeEvent(event)}`);
    });
    this.worker = worker;
    return worker;
  }

  private receive(event: unknown): void {
    const reply = (event as { data?: unknown } | null | undefined)?.data;
    if (!isReply(reply)) {
      // A message that is not a reply cannot be matched to a request, and the requests that are
      // waiting would otherwise wait forever.
      this.close('the disc cache worker sent a message that is not a reply');
      return;
    }
    const entry = this.pending.get(reply.id);
    // A reply to a request nobody is waiting for any more: an aborted download, most likely.
    if (!entry) return;
    this.pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply.value);
    else entry.reject(remoteError(reply.error));
  }
}

/** One cache identity, as the `DiscStore` `disc-cache.ts` asks for. */
class WorkerDiscStore implements DiscStore {
  constructor(
    private readonly client: WorkerClient,
    private readonly identity: string,
  ) {}

  async length(): Promise<number> {
    const value = await this.client.request({ op: 'length', identity: this.identity });
    if (typeof value !== 'number') throw answered('length', value);
    return value;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const value = await this.client.request({ op: 'read', identity: this.identity, offset, length });
    if (!(value instanceof Uint8Array)) throw answered('read', value);
    return value;
  }

  async append(offset: number, bytes: Uint8Array): Promise<void> {
    await this.client.request({ op: 'append', identity: this.identity, offset, bytes });
  }

  async truncate(size: number): Promise<void> {
    await this.client.request({ op: 'truncate', identity: this.identity, size });
  }

  async file(): Promise<File> {
    const value = await this.client.request({ op: 'file', identity: this.identity });
    // A `File` is a `Blob` with a name, and the name is not decoration: the core mounts the disc
    // under it (`--iso /disc/<name>`), so a reply without one is refused here.
    if (!(value instanceof Blob) || typeof (value as File).name !== 'string') {
      throw answered('file', value);
    }
    return value as File;
  }

  async remove(): Promise<void> {
    await this.client.request({ op: 'remove', identity: this.identity });
  }
}

/** What a reply that is not the shape the operation promised looks like. */
function answered(op: string, value: unknown): Error {
  const type = value === null ? 'null' : typeof value;
  return new Error(`the disc cache worker answered ${op} with ${type}, not with the value it promised`);
}

/** The reply, if it is one. An unknown `id` is not: nothing could be matched to it. */
function isReply(value: unknown): value is DiscStoreReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as { id?: unknown; ok?: unknown };
  return typeof reply.id === 'number' && Number.isSafeInteger(reply.id) && typeof reply.ok === 'boolean';
}

/** The worker's error, with its own name kept: `NotFoundError` must not become a generic failure. */
function remoteError(error: { name: string; message: string }): Error {
  const reconstructed = new Error(error.message);
  reconstructed.name = error.name;
  return reconstructed;
}

function describeEvent(event: unknown): string {
  const message = (event as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.length > 0 ? message : String(event);
}

/** The browser's own worker: a module worker of this very origin, so OPFS is the same OPFS. */
function browserWorker(): DiscStoreWorkerLike {
  return new Worker(new URL('./opfs-worker.ts', import.meta.url), { type: 'module' });
}

/**
 * A `DiscStoreFactory` backed by the OPFS worker.
 *
 * The factory is a function -- `disc-cache.ts` asks for one store per cache identity -- with a
 * `close()` on it, so the page can release the worker when the disc has been deleted or the run is
 * over.
 */
export function opfsDiscStoreFactory(options: OpfsDiscStoreOptions = {}): OpfsDiscStoreFactory {
  const client = new WorkerClient(options.worker ?? browserWorker);
  const factory = ((identity: string) => client.store(identity)) as OpfsDiscStoreFactory;
  factory.close = () => client.close();
  return factory;
}
