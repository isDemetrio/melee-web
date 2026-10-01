/**
 * The page's choice of disc: the cache when it is verified, the selector when it is not, and a
 * working page in every case where the cache cannot answer.
 *
 * The case that matters most is the last one. The manifest is served by a Cloudflare Function,
 * so a local preview, a deploy without the binding, or a phone that lost its connection all
 * reach `chooseDisc` with a cache that throws -- and none of them may cost the operator the
 * ability to run from the file selector.
 */

import { describe, expect, it, vi } from 'vitest';
import { chooseDisc, type DiscCacheLike } from '../../src/spike/disc-source.js';

function file(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });
}

function cache(overrides: Partial<DiscCacheLike> = {}): DiscCacheLike {
  return {
    getVerifiedDisc: async () => null,
    storageStatus: async () => ({ persisted: false }),
    ...overrides,
  };
}

describe('chooseDisc', () => {
  it('prefers the verified cached disc over the picked file', async () => {
    const cached = file('melee-ntsc102.iso');
    const choice = await chooseDisc(cache({ getVerifiedDisc: async () => cached }), file('picked.iso'));
    expect(choice?.file).toBe(cached);
    expect(choice?.source).toBe('opfs');
  });

  it('falls back to the picked file when the cache holds nothing verified', async () => {
    const picked = file('picked.iso');
    const choice = await chooseDisc(cache(), picked);
    expect(choice?.file).toBe(picked);
    expect(choice?.source).toBe('picker');
  });

  it('answers null when there is neither a cached disc nor a picked file', async () => {
    expect(await chooseDisc(cache(), null)).toBeNull();
  });

  it('runs from the selector when the cache cannot answer at all', async () => {
    // A 404, an HTML sign-in page, a worker that died: all of them arrive here as a throw.
    const picked = file('picked.iso');
    const failing = cache({
      getVerifiedDisc: async () => {
        throw new Error('/phase0/disc-chunks answered with text/html, which is a page and not a manifest');
      },
    });
    const choice = await chooseDisc(failing, picked);
    expect(choice?.file).toBe(picked);
    expect(choice?.source).toBe('picker');
  });

  it('reports a storage manager that throws as not persisted, without failing the run', async () => {
    const picked = file('picked.iso');
    const failing = cache({
      storageStatus: async () => {
        throw new Error('storage is unavailable');
      },
    });
    const choice = await chooseDisc(failing, picked);
    expect(choice?.storagePersisted).toBe(false);
    expect(choice?.source).toBe('picker');
  });

  it('reads the storage status even when there is no disc to run with', async () => {
    // `storage_persisted` describes the origin, not the run: a result with no disc in it is not
    // a reason to skip the question, and the answer is what tells an operator whether a cache
    // will survive to the next run.
    const storageStatus = vi.fn(async () => ({ persisted: true, quota: 100, usage: 10 }));
    expect(await chooseDisc(cache({ storageStatus }), null)).toBeNull();
    expect(storageStatus).toHaveBeenCalledTimes(1);
  });

  it('reports the persisted answer with a cached disc, so an OPFS run is evidence', async () => {
    const cached = file('melee-ntsc102.iso');
    const choice = await chooseDisc(
      cache({ getVerifiedDisc: async () => cached, storageStatus: async () => ({ persisted: true }) }),
      file('picked.iso'),
    );
    expect(choice).toEqual({ file: cached, source: 'opfs', storagePersisted: true });
  });
});
