import { expect, test } from '@playwright/test';
import { HANDOFF_WAITS_MS } from '../../src/spike/sync-handle';

/**
 * The OPFS handle handoff, measured in a real browser.
 *
 * The play worker holds a sync access handle on the cached disc for the whole game
 * (`web/src/play/disc-reader.ts`) and never yields while the game runs. Stopping a game terminates
 * it; pressing Play again has the new session's store worker open the same file. Whether that open
 * can come before the platform has released the old handle is the platform's business, so it is
 * measured here: the two workers below do exactly that, with the waits `openSyncHandle` uses, and
 * the test fails if the file is still held when those waits run out.
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
  const start = performance.now();
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(event.data.name);
  const refusals = [];
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await file.createSyncAccessHandle();
      const size = handle.getSize();
      handle.close();
      postMessage({ opened: true, size, refusals, ms: performance.now() - start });
      return;
    } catch (error) {
      refusals.push(error.name);
      const delay = event.data.waits[attempt];
      if (delay === undefined) { postMessage({ opened: false, refusals, ms: performance.now() - start }); return; }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};`;

interface Handoff { opened: boolean; size?: number; refusals: string[]; ms: number }

test.describe('OPFS sync access handle handoff', () => {
  for (const how of ['terminated while spinning', 'closed'] as const) {
    test(`a second worker opens the file after the first one is ${how}`, async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async ({ holder, opener, waits, close }): Promise<Handoff> => {
        const name = `handoff-probe-${close ? 'closed' : 'terminated'}.bin`;
        const start = (source: string) => new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        const first = start(holder);
        const said = await new Promise<string>((resolve, reject) => {
          first.onmessage = (event) => resolve(String(event.data));
          first.onerror = (event) => reject(new Error(`holder failed: ${event.message}`));
          first.postMessage({ name, close });
        });
        if (said === 'held') first.terminate();
        const second = start(opener);
        const outcome = await new Promise<Handoff>((resolve, reject) => {
          second.onmessage = (event) => resolve(event.data as Handoff);
          second.onerror = (event) => reject(new Error(`opener failed: ${event.message}`));
          second.postMessage({ name, waits });
        });
        second.terminate();
        // A file still held cannot be removed; the assertion below says why, so it is left alone.
        if (outcome.opened) await (await navigator.storage.getDirectory()).removeEntry(name);
        return outcome;
      }, { holder: HOLDER, opener: OPENER, waits: [...HANDOFF_WAITS_MS], close: how === 'closed' });
      // The numbers, in the CI log: how many opens were refused, with what, and how long it took.
      console.log(`handoff after the holder was ${how}: ${JSON.stringify(result)}`);
      test.info().annotations.push({ type: 'handoff', description: JSON.stringify(result) });
      expect(result.opened, `still held after the waits: ${result.refusals.join(', ')}`).toBe(true);
      expect(result.size).toBe(4096);
    });
  }
});
