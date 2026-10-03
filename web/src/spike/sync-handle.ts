/**
 * Opening an OPFS sync access handle on a file another context is still letting go of.
 *
 * OPFS grants one sync access handle per file, and the play worker holds one on the cached disc for
 * the whole game (`web/src/play/disc-reader.ts`). When the page stops a game it terminates that
 * worker, and the platform releases the handle afterwards, asynchronously: WebKit when the worker's
 * context stops (`FileSystemSyncAccessHandle::stop`, then an IPC to the storage process), Chromium
 * when the worker's connection closes. Press Play again and the new session's store worker opens
 * the same file to check the cache (`opfs-worker.ts`, `length()`); if it gets there before the
 * release, the platform refuses it -- `InvalidStateError` on WebKit, `NoModificationAllowedError`
 * on Chromium -- and the game would not start.
 *
 * So a refusal with one of those two names is retried a few times, about three seconds in all,
 * and the last refusal is passed on with what was tried. A handle held for longer than that is not
 * a release in progress (a game running in another tab, say), and is reported, not waited out.
 */

/** The waits between attempts, in ms: six retries, 3.15 s in all. */
export const HANDOFF_WAITS_MS: readonly number[] = [50, 100, 200, 400, 800, 1600];

/** `true` for the refusals OPFS makes while another handle holds the file. */
export function isHandleHeld(error: unknown): boolean {
  const name = !!error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'InvalidStateError' || name === 'NoModificationAllowedError';
}

export type Wait = (ms: number) => Promise<void>;

export const timerWait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `file.createSyncAccessHandle()`, retried while the file is held by a handle that is being
 * released. Any other failure is passed on at once. After the last wait the error says how long the
 * file was held, and keeps the platform's own error as its `cause`.
 */
export async function openSyncHandle<H>(file: { createSyncAccessHandle(): Promise<H> }, wait: Wait = timerWait,
  waits: readonly number[] = HANDOFF_WAITS_MS): Promise<H> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await file.createSyncAccessHandle();
    } catch (error) {
      if (!isHandleHeld(error)) throw error;
      const delay = waits[attempt];
      if (delay === undefined) {
        throw new Error(`the file is held by another sync access handle, still after ${waited} ms `
          + `(a game running in another tab?): ${String(error)}`, { cause: error });
      }
      await wait(delay);
      waited += delay;
    }
  }
}
