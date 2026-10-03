import { describe, expect, it } from 'vitest';
import { HANDOFF_BUDGET_MS, handoffWait, isHandleHeld, openSyncHandle } from '../../src/spike/sync-handle';

const named = (name: string) => Object.assign(new Error(`${name} from the platform`), { name });

/**
 * A file whose first opens fail with `refusals` (every open with `forever`), and a wait that only
 * records.
 */
function heldFile(refusals: Error[], forever: Error | null = null) {
  let opens = 0;
  const handle = { id: 'handle' };
  const waits: number[] = [];
  return {
    file: {
      async createSyncAccessHandle() {
        const refusal = forever ?? refusals[opens];
        opens++;
        if (refusal) throw refusal;
        return handle;
      },
    },
    wait: async (ms: number) => { waits.push(ms); },
    handle, waits, opens: () => opens,
  };
}

describe('openSyncHandle', () => {
  it('knows the refusals of a held file on WebKit and on Chromium, and nothing else', () => {
    expect(isHandleHeld(named('InvalidStateError'))).toBe(true);
    expect(isHandleHeld(named('NoModificationAllowedError'))).toBe(true);
    expect(isHandleHeld(named('NotFoundError'))).toBe(false);
    expect(isHandleHeld('InvalidStateError')).toBe(false);
    expect(isHandleHeld(null)).toBe(false);
  });

  it('opens at once when nothing holds the file', async () => {
    const held = heldFile([]);
    expect(await openSyncHandle(held.file, held.wait)).toBe(held.handle);
    expect(held.waits).toEqual([]);
  });

  it('waits out a handle that is being released, longer each time', async () => {
    const held = heldFile([named('InvalidStateError'), named('NoModificationAllowedError'), named('InvalidStateError')]);
    expect(await openSyncHandle(held.file, held.wait)).toBe(held.handle);
    expect(held.waits).toEqual([50, 100, 200]);
    expect(held.opens()).toBe(4);
    expect([3, 4, 40].map(handoffWait)).toEqual([250, 250, 250]);
  });

  it('reports a file held for longer than the budget, with the platform\'s error as the cause', async () => {
    const refusal = named('InvalidStateError');
    const held = heldFile([], refusal);
    const error = await openSyncHandle(held.file, held.wait).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(new RegExp(`held by another sync access handle, still after ${HANDOFF_BUDGET_MS} ms`));
    expect((error as Error).cause).toBe(refusal);
    expect(held.waits.reduce((sum, ms) => sum + ms, 0)).toBe(HANDOFF_BUDGET_MS);
    expect(held.waits.slice(0, 4)).toEqual([50, 100, 200, 250]);
    expect(Math.max(...held.waits)).toBe(250);
    expect(held.opens()).toBe(held.waits.length + 1);
  });

  it('passes any other failure on at once', async () => {
    const missing = named('NotFoundError');
    const held = heldFile([missing]);
    await expect(openSyncHandle(held.file, held.wait)).rejects.toBe(missing);
    expect(held.waits).toEqual([]);
  });
});
