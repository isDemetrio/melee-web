/**
 * Opening an OPFS sync access handle on a file another context is still letting go of.
 *
 * OPFS grants one sync access handle per file, and the play worker holds one on the cached disc for
 * the whole game (`web/src/play/disc-reader.ts`). When the page stops a game it terminates that
 * worker, and the platform releases the handle afterwards, asynchronously: WebKit when the worker's
 * context stops (`FileSystemSyncAccessHandle::stop`, then an IPC to the storage process), Chromium
 * when the worker's thread is gone. Press Play again and the new session's store worker opens the
 * same file to check the cache (`opfs-worker.ts`, `length()`); if it gets there before the release,
 * the platform refuses it -- `InvalidStateError` on WebKit, `NoModificationAllowedError` on
 * Chromium -- and the game would not start.
 *
 * Measured in CI (`web/tests/e2e/opfs-handoff.spec.ts`): Chromium releases the handle of a worker
 * terminated while it never yields about 3.1 s after `terminate()`, and refuses every open until
 * then. So a refusal with one of those two names is retried every 250 ms or less for up to
 * `HANDOFF_BUDGET_MS`, and the last refusal is passed on with how long the file was held. A handle
 * held for longer than that is not a release in progress (a game running in another tab, say), and
 * is reported, not waited out.
 */

/** How long a held file is waited for before it is reported: three times what Chromium took. */
export const HANDOFF_BUDGET_MS = 10_000;

/** The wait after the n-th refusal: 50, 100, 200, then 250 ms. */
export function handoffWait(attempt: number): number {
  return Math.min(50 * 2 ** attempt, 250);
}

/** `true` for the refusals OPFS makes while another handle holds the file. */
export function isHandleHeld(error: unknown): boolean {
  const name = !!error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'InvalidStateError' || name === 'NoModificationAllowedError';
}

export type Wait = (ms: number) => Promise<void>;

export const timerWait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `file.createSyncAccessHandle()`, retried while the file is held by a handle that is being
 * released. Any other failure is passed on at once. Once the waits add up to `budgetMs`, the error
 * says how long the file was held, and keeps the platform's own error as its `cause`.
 */
export async function openSyncHandle<H>(file: { createSyncAccessHandle(): Promise<H> }, wait: Wait = timerWait,
  budgetMs = HANDOFF_BUDGET_MS): Promise<H> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await file.createSyncAccessHandle();
    } catch (error) {
      if (!isHandleHeld(error)) throw error;
      if (waited >= budgetMs) {
        throw new Error(`the file is held by another sync access handle, still after ${waited} ms `
          + `(a game running in another tab?): ${String(error)}`, { cause: error });
      }
      const delay = Math.min(handoffWait(attempt), budgetMs - waited);
      await wait(delay);
      waited += delay;
    }
  }
}
