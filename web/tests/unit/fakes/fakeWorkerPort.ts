/**
 * A worker, as far as the page's side of the disc cache can tell.
 *
 * The client in `web/src/spike/opfs-store.ts` is tested against the *real* request handler from
 * `opfs-worker.ts` over the fake file system in `fakeSyncOpfs.ts`, reached through this port: the
 * messages, the ids and the replies are the ones that will cross a real `postMessage`, and only
 * the worker's own plumbing is replaced.
 *
 * The port can also misbehave in the two ways that matter for the client:
 *
 *  - a reply can be **held** (`gate`), so a test can make the second answer arrive before the
 *    first and see whether the ids are what matches them;
 *  - an **error event** can be delivered, which carries no id and therefore fails every request
 *    in flight.
 */

import type { DiscStoreWorkerLike } from '../../../src/spike/opfs-store.js';
import type { DiscStoreReply, DiscStoreRequest } from '../../../src/spike/opfs-worker.js';

export class FakeWorkerPort implements DiscStoreWorkerLike {
  /** Test-only: every request posted, in order. */
  readonly requests: DiscStoreRequest[] = [];
  /** Test-only: true once the client dropped this worker. */
  terminated = false;
  /** Asked before each answer: return a promise to hold the answer, or null to answer now. */
  gate: ((request: DiscStoreRequest) => Promise<void> | null) | null = null;
  private readonly messageListeners: ((event: unknown) => void)[] = [];
  private readonly errorListeners: ((event: unknown) => void)[] = [];

  constructor(private readonly answer: (request: DiscStoreRequest) => Promise<DiscStoreReply>) {}

  postMessage(message: DiscStoreRequest): void {
    this.requests.push(message);
    const hold = this.gate?.(message) ?? null;
    void (async () => {
      if (hold) await hold;
      const reply = await this.answer(message);
      for (const listener of this.messageListeners) listener({ data: reply });
    })();
  }

  addEventListener(type: 'message' | 'error', listener: (event: unknown) => void): void {
    if (type === 'message') this.messageListeners.push(listener);
    else this.errorListeners.push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Test-only: deliver a message that is not a reply. */
  emitMessage(data: unknown): void {
    for (const listener of this.messageListeners) listener({ data });
  }

  /** Test-only: make the worker fail, the way an uncaught error in it would. */
  fail(message: string): void {
    for (const listener of this.errorListeners) listener({ message });
  }
}
