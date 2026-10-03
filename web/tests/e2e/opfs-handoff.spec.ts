import { expect, test } from '@playwright/test';
import { HANDOFF_BUDGET_MS } from '../../src/spike/sync-handle';

/**
 * The OPFS handle handoff, measured in a real browser.
 *
 * The play worker holds a sync access handle on the cached disc for the whole game
 * (`web/src/play/disc-reader.ts`) and never yields while the game runs. Stopping a game terminates
 * it; pressing Play again has the new session's store worker open the same file. How long after
 * `terminate()` the platform still refuses that open is the platform's business, so it is measured
 * here: one worker takes the handle and spins, the page terminates it, and a second worker tries to
 * open the file every 25 ms. `openSyncHandle` waits up to `HANDOFF_BUDGET_MS` for the release; the
 * test fails when the release takes more than half of that, so the budget keeps a margin of two.
 *
 * Chromium only (playwright.config.ts). What WebKit on iOS does is not measured by this test.
 */
const HOLDER = `
onmessage = async (event) => {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(event.data.name, { create: true });
  const handle = await file.createSyncAccessHandle();
  handle.write(new Uint8Array(4096), { at: 0 });
  handle.flush();
  if (event.data.close) { handle.close(); postMessage('released'); return; }
  postMessage('held');
  // Never yields again, like the play worker inside callMain.
  for (;;) { /* spin */ }
};`;

const OPENER = `
onmessage = async (event) => {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(event.data.name);
  // Since the page's terminate(), on the clock both agents share.
  const elapsed = () => performance.timeOrigin + performance.now() - event.data.since;
  const refusals = {};
  for (;;) {
    try {
      const handle = await file.createSyncAccessHandle();
      const size = handle.getSize();
      handle.close();
      postMessage({ opened: true, size, refusals, ms: elapsed() });
      return;
    } catch (error) {
      refusals[error.name] = (refusals[error.name] ?? 0) + 1;
      if (elapsed() > event.data.giveUpMs) {
        postMessage({ opened: false, refusals, ms: elapsed() });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};`;

interface Handoff { opened: boolean; size?: number; refusals: Record<string, number>; ms: number }

interface HandoffArgs { holder: string; opener: string; giveUpMs: number; close: boolean; name: string }

/**
 * One handoff, run in the page: the holder takes the file, is terminated (or closes it), and the
 * opener polls. Playwright sends the function as source, so it uses its arguments only.
 */
async function handoff({ holder, opener, giveUpMs, close, name }: HandoffArgs): Promise<Handoff> {
  const start = (source: string) => new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  const first = start(holder);
  const said = await new Promise<string>((resolve, reject) => {
    first.onmessage = (event) => resolve(String(event.data));
    first.onerror = (event) => reject(new Error(`holder failed: ${event.message}`));
    first.postMessage({ name, close });
  });
  // Wall time on the high-resolution clock, so the opener can measure from the same instant.
  const since = performance.timeOrigin + performance.now();
  if (said === 'held') first.terminate();
  const second = start(opener);
  const outcome = await new Promise<Handoff>((resolve, reject) => {
    second.onmessage = (event) => resolve(event.data as Handoff);
    second.onerror = (event) => reject(new Error(`opener failed: ${event.message}`));
    second.postMessage({ name, since, giveUpMs });
  });
  second.terminate();
  // A file still held cannot be removed; the assertion below says why, so it is left alone.
  if (outcome.opened) await (await navigator.storage.getDirectory()).removeEntry(name);
  return outcome;
}

test.describe('OPFS sync access handle handoff', () => {
  test('a terminated worker that never yields releases the handle well inside the budget', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    const results: Handoff[] = [];
    for (let run = 0; run < 3; run++) {
      results.push(await page.evaluate(handoff, { holder: HOLDER, opener: OPENER, giveUpMs: 2 * HANDOFF_BUDGET_MS,
        close: false, name: `handoff-probe-${run}.bin` }));
    }
    // The numbers, in the CI log: how many opens were refused, with what, and when the file opened.
    console.log(`handoff after terminate() of a spinning holder: ${JSON.stringify(results)}`);
    for (const result of results) {
      expect(result.opened, `still held after ${result.ms} ms: ${JSON.stringify(result.refusals)}`).toBe(true);
      expect(result.size).toBe(4096);
      expect(result.ms, 'the release takes more than half of HANDOFF_BUDGET_MS').toBeLessThan(HANDOFF_BUDGET_MS / 2);
    }
  });

  test('a handle that was closed is free at once', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(handoff, { holder: HOLDER, opener: OPENER, giveUpMs: 2 * HANDOFF_BUDGET_MS,
      close: true, name: 'handoff-probe-closed.bin' });
    console.log(`handoff after close(): ${JSON.stringify(result)}`);
    expect([result.opened, result.size, result.refusals]).toEqual([true, 4096, {}]);
  });
});
