/**
 * Which disc the page runs with, and what it is allowed to say about it.
 *
 * The spike page has two possible discs: the one the operator picks with the file selector, and
 * the one the cache already holds, verified piece by piece (`disc-cache.ts`). The cache is the
 * point of PR 4 -- a 1.36 GiB download that survives a reload -- but the page must keep working
 * when the cache has nothing to offer. The manifest is served by a Cloudflare Function, and a
 * page opened without it (a local preview, a deploy where the binding is missing, a phone whose
 * connection dropped mid-download) must still be able to run from the selector.
 *
 * Three rules, each one asserted in `web/tests/unit/disc-source.test.ts`:
 *
 *  1. **A verified cached disc wins over the picked file.** The cached one has been hashed
 *     piece by piece and its total length checked against the manifest; the picked file has
 *     been checked for its size and for nothing else.
 *  2. **A cache that cannot answer is not a failure.** A missing manifest, an HTML sign-in page
 *     where the manifest should be, a storage manager that throws, a worker that died: each of
 *     them means "no cached disc", and the selector still runs. What must never happen is a page
 *     that refuses to start because a cache it does not need is unhappy.
 *  3. **The answer says where the disc came from.** `disc_source` in the result JSON is the
 *     evidence that a run used the cache or did not; without it, an operator reading a result
 *     cannot tell an OPFS run from a selector run, and the two are not the same measurement.
 *
 * Nothing here touches OPFS or the network: the cache is an interface, so every branch above is
 * reachable in a unit test with a few lines of stand-in.
 */

import type { DiscStorageStatus } from './disc-cache.js';

/** The part of `disc-cache.ts`'s `DiscCache` this module uses. */
export interface DiscCacheLike {
  /** The whole disc as a `File` when it is stored and verified, otherwise `null`. */
  getVerifiedDisc(): Promise<File | null>;
  /** What the browser says about the origin's storage. */
  storageStatus(): Promise<DiscStorageStatus>;
}

/** Where the disc the page is about to run came from. */
export type DiscSource = 'opfs' | 'picker';

export interface DiscChoice {
  readonly file: File;
  readonly source: DiscSource;
  /**
   * Whether the origin's storage is persisted, as the browser answered at the moment of the
   * run. It is reported rather than demanded: a denied `persist()` request does not fail a run,
   * it only means the cached disc may be evicted between two runs.
   */
  readonly storagePersisted: boolean;
}

/**
 * The disc to run with, or `null` when there is none: no verified cache entry and no picked file.
 *
 * `picked` is what the file selector holds, which is `null` when the operator has not chosen a
 * file. The cached disc is asked for first and the storage status is read either way, because
 * `storage_persisted` describes the origin, not the run.
 */
export async function chooseDisc(
  cache: DiscCacheLike,
  picked: File | null,
): Promise<DiscChoice | null> {
  const storagePersisted = await persisted(cache);
  const cached = await cachedDisc(cache);
  if (cached) return { file: cached, source: 'opfs', storagePersisted };
  if (picked) return { file: picked, source: 'picker', storagePersisted };
  return null;
}

/**
 * The verified cached disc, or `null` when the cache cannot produce one.
 *
 * A cache that throws is a cache with nothing to offer: the manifest may be a page, the worker
 * may have died, the origin may have no storage at all. Each of those is answered the same way,
 * because the selector is the fallback and it is always allowed to work.
 */
async function cachedDisc(cache: DiscCacheLike): Promise<File | null> {
  try {
    return await cache.getVerifiedDisc();
  } catch {
    return null;
  }
}

/** Whether the origin's storage is persisted. A storage manager that throws is not persisted. */
async function persisted(cache: DiscCacheLike): Promise<boolean> {
  try {
    return (await cache.storageStatus()).persisted;
  } catch {
    return false;
  }
}
