import { describe, expect, it } from 'vitest';
import { HANDOFF_WAITS_MS, isHandleHeld, openSyncHandle } from '../../src/spike/sync-handle';

const named = (name: string) => Object.assign(new Error(`${name} from the platform`), { name });

/** A file whose first `refusals` opens fail with the given errors, and a wait that only records. */
function heldFile(refusals: Error[]) {
  let opens = 0;
  const handle = { id: 'handle' };
  const waits: number[] = [];
  return {
    file: {
      async createSyncAccessHandle() {
        const refusal = refusals[opens++];
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
    expect(held.waits).toEqual(HANDOFF_WAITS_MS.slice(0, 3));
    expect(held.opens()).toBe(4);
  });

  it('reports a file held for longer than the waits, with the platform\'s error as the cause', async () => {
    const refusal = named('InvalidStateError');
    const held = heldFile(Array.from({ length: HANDOFF_WAITS_MS.length + 1 }, () => refusal));
    const total = HANDOFF_WAITS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBe(3150);
    const error = await openSyncHandle(held.file, held.wait).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(new RegExp(`held by another sync access handle, still after ${total} ms`));
    expect((error as Error).cause).toBe(refusal);
    expect(held.waits).toEqual(HANDOFF_WAITS_MS);
  });

  it('passes any other failure on at once', async () => {
    const missing = named('NotFoundError');
    const held = heldFile([missing]);
    await expect(openSyncHandle(held.file, held.wait)).rejects.toBe(missing);
    expect(held.waits).toEqual([]);
  });
});
