/**
 * The asset cache: manifest in, verified bytes out.
 *
 * Three properties are load-bearing and each one is asserted here rather than described:
 * nothing reaches the caller unverified, a hit costs no network, and a store that refuses to
 * write does not fail the load. The bucket is a fake with a request log, so "no network" is a
 * count and not an opinion.
 *
 * The last test is the one that matters for a reload: the same fake OPFS root, a second cache,
 * and a fetch that throws -- the bytes still come back.
 */

import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssetCache,
  AssetFetchError,
  AssetIntegrityError,
  cacheFor,
  sha256Hex,
  type AssetCacheOptions,
} from '../../src/assets/cache.js';
import {
  AssetStoreError,
  MemoryAssetStore,
  OpfsAssetStore,
  type AssetStore,
} from '../../src/assets/store.js';
import { fakeOpfsRoot } from './fakes/fakeOpfs.js';
import { entryFor, fakeBucket, manifestWith, nodeDigest, sha256Of } from './fakes/assetFixtures.js';

const BASE = 'https://assets.example/';
const text = (value: string) => new TextEncoder().encode(value);
const urlOf = (entry: { stored: string }) => `${BASE}${entry.stored}`;

function cacheOver(store: AssetStore, options: Partial<AssetCacheOptions> = {}): AssetCache {
  return new AssetCache(store, { baseUrl: BASE, digest: nodeDigest, ...options });
}

/** A store that accepts nothing: quota, a revoked directory, a closed stream. */
class RefusingWriteStore extends MemoryAssetStore {
  override async write(): Promise<void> {
    throw new Error('QuotaExceededError: the origin is out of space');
  }
}

/** A store that cannot be read at all, which is not the same thing as an empty one. */
class UnreadableStore extends MemoryAssetStore {
  override async read(): Promise<Uint8Array | null> {
    throw new Error('the file system is gone');
  }
}

describe('AssetCache', () => {
  it('verifies the bytes against the manifest hash and stores them under it', async () => {
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), bytes);
    const store = new MemoryAssetStore();

    const cache = cacheOver(store, { fetch: bucket.fetch });

    expect(await cache.load(entry)).toEqual(bytes);
    expect(bucket.urls).toEqual([urlOf(entry)]);
    // The cache key is the manifest's own name for the bytes, so a hit is a statement about
    // content and two identical assets share one slot.
    expect(entry.stored).toBe(`${sha256Of(bytes)}.bin`);
    expect(await store.read(entry.stored)).toEqual(bytes);
  });

  it('serves the second request from the store, without touching the network', async () => {
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), bytes);
    const cache = cacheOver(new MemoryAssetStore(), { fetch: bucket.fetch });

    await cache.load(entry);
    expect(await cache.load(entry)).toEqual(bytes);
    expect(bucket.urls).toHaveLength(1);
  });

  it('stores nothing when the bytes do not match the manifest hash', async () => {
    // Same length, different content: only the hash can catch this, and a wrong asset in this
    // project changes simulation state, which looks exactly like a netcode fault.
    const claimed = text('melee-a');
    const served = text('melee-b');
    const entry = entryFor('files/boot/opening.mov', claimed);
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), served);
    const store = new MemoryAssetStore();

    const cache = cacheOver(store, { fetch: bucket.fetch });

    await expect(cache.load(entry)).rejects.toThrow(AssetIntegrityError);
    expect(await store.has(entry.stored)).toBe(false);
  });

  it('checks the length before the hash, so a truncated object is named as such', async () => {
    const entry = entryFor('files/boot/opening.mov', text('melee-asset'));
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), text('melee'));
    const cache = cacheOver(new MemoryAssetStore(), { fetch: bucket.fetch });

    await expect(cache.load(entry)).rejects.toThrow(/expected 11 bytes, received 5/);
  });

  it('decodes a gzip object before checking it, and stores the decoded bytes', async () => {
    // `encoding: gzip` means the bucket object is a gzip member, which is not the same thing as
    // a Content-Encoding the transport already removed.
    const raw = text('melee-asset');
    const entry = entryFor('files/audio/bgm/01.mus', raw, { encoding: 'gzip' });
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), new Uint8Array(gzipSync(raw)));
    const store = new MemoryAssetStore();

    const cache = cacheOver(store, { fetch: bucket.fetch });

    expect(await cache.load(entry)).toEqual(raw);
    expect(await store.read(entry.stored)).toEqual(raw);
  });

  it('reports a non-2xx answer as a fetch failure, not as an empty asset', async () => {
    const entry = entryFor('files/boot/opening.mov', text('melee'));
    const bucket = fakeBucket();
    bucket.refuse(urlOf(entry), 404);
    const cache = cacheOver(new MemoryAssetStore(), { fetch: bucket.fetch });

    await expect(cache.load(entry)).rejects.toThrow(AssetFetchError);
    await expect(cache.load(entry)).rejects.toThrow(/status 404/);
  });

  it('wraps a transport failure so the caller sees one error type', async () => {
    const entry = entryFor('files/boot/opening.mov', text('melee'));
    const bucket = fakeBucket();
    bucket.breakWith(urlOf(entry), new TypeError('Failed to fetch'));
    const cache = cacheOver(new MemoryAssetStore(), { fetch: bucket.fetch });

    await expect(cache.load(entry)).rejects.toThrow(AssetFetchError);
    await expect(cache.load(entry)).rejects.toThrow(/Failed to fetch/);
  });

  it('still returns the bytes when the store refuses to write', async () => {
    // Caching is an optimisation. Refusing to boot because the cache is full would be a worse
    // bug than re-fetching the asset next time.
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), bytes);
    const cache = cacheOver(new RefusingWriteStore(), { fetch: bucket.fetch });

    expect(await cache.load(entry)).toEqual(bytes);
  });

  it('treats a store that cannot be read as an empty one', async () => {
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), bytes);
    const cache = cacheOver(new UnreadableStore(), { fetch: bucket.fetch });

    expect(await cache.load(entry)).toEqual(bytes);
    expect(bucket.urls).toHaveLength(1);
  });

  it('does not swallow a cache key the store refuses', async () => {
    // A key that is not a hash is a manifest bug. Treating it as a miss would hide it and let
    // the same bad name through on every load.
    const entry = entryFor('files/boot/opening.mov', text('melee'), { stored: 'not-a-hash' });
    const bucket = fakeBucket();
    const cache = cacheOver(new MemoryAssetStore(), { fetch: bucket.fetch });

    await expect(cache.load(entry)).rejects.toThrow(AssetStoreError);
    expect(bucket.urls).toHaveLength(0);
  });

  it('drops a cache file whose length is not what the manifest says, and fetches again', async () => {
    // What quota eviction actually produces. A file whose length is wrong cannot be what its
    // name claims, so it is dropped rather than served.
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const store = new MemoryAssetStore();
    await store.write(entry.stored, text('melee'));
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), bytes);

    const cache = cacheOver(store, { fetch: bucket.fetch });

    expect(await cache.load(entry)).toEqual(bytes);
    expect(bucket.urls).toHaveLength(1);
    expect(await store.read(entry.stored)).toEqual(bytes);
  });

  it('re-hashes a hit only when asked, and drops a file that lies about its name', async () => {
    const right = text('melee-a');
    const wrong = text('melee-b');
    const entry = entryFor('files/boot/opening.mov', right);
    const store = new MemoryAssetStore();
    await store.write(entry.stored, wrong);
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), right);

    // By default the file name is trusted, because it *is* the hash and re-hashing costs a pass
    // over the whole asset on every read.
    const trusting = cacheOver(store, { fetch: bucket.fetch });
    expect(await trusting.load(entry)).toEqual(wrong);
    expect(bucket.urls).toHaveLength(0);

    // The settings screen can turn the check on to diagnose a suspicious install.
    const verifying = cacheOver(store, { fetch: bucket.fetch, verifyOnRead: true });
    expect(await verifying.load(entry)).toEqual(right);
    expect(bucket.urls).toHaveLength(1);
  });

  it('shares one fetch between two requests for the same asset', async () => {
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), bytes);
    const cache = cacheOver(new MemoryAssetStore(), { fetch: bucket.fetch });

    const both = await Promise.all([cache.load(entry), cache.load(entry)]);

    expect(both).toEqual([bytes, bytes]);
    expect(bucket.urls).toHaveLength(1);
  });

  it('forgets a failed load, so the next attempt fetches again', async () => {
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const bucket = fakeBucket();
    bucket.breakWith(urlOf(entry), new TypeError('offline'));
    const cache = cacheOver(new MemoryAssetStore(), { fetch: bucket.fetch });

    await expect(cache.load(entry)).rejects.toThrow(AssetFetchError);
    bucket.serve(urlOf(entry), bytes);
    expect(await cache.load(entry)).toEqual(bytes);
    expect(bucket.urls).toHaveLength(2);
  });

  it('reports a complete cache file as present and a truncated one as absent', async () => {
    const entry = entryFor('files/boot/opening.mov', text('melee-asset'));
    const store = new MemoryAssetStore();
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), text('melee-asset'));
    const cache = cacheOver(store, { fetch: bucket.fetch });

    expect(await cache.has(entry)).toBe(false);
    await cache.load(entry);
    expect(await cache.has(entry)).toBe(true);

    await store.write(entry.stored, text('melee'));
    expect(await cache.has(entry)).toBe(false);
  });

  it('evicts one asset and clears the rest', async () => {
    const one = entryFor('files/one', text('melee-a'));
    const two = entryFor('files/two', text('melee-b'));
    const store = new MemoryAssetStore();
    const bucket = fakeBucket();
    bucket.serve(urlOf(one), text('melee-a'));
    bucket.serve(urlOf(two), text('melee-b'));
    const cache = cacheOver(store, { fetch: bucket.fetch });

    await cache.load(one);
    await cache.load(two);
    await cache.evict(one);
    expect(await store.has(one.stored)).toBe(false);
    expect(await store.has(two.stored)).toBe(true);

    await cache.clear();
    expect(store.size).toBe(0);
  });

  it('reads a reloaded session out of OPFS with no network at all', async () => {
    const root = fakeOpfsRoot();
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const bucket = fakeBucket();
    bucket.serve(urlOf(entry), bytes);

    const first = cacheOver(new OpfsAssetStore(root), { fetch: bucket.fetch });
    expect(await first.load(entry)).toEqual(bytes);

    // A second session over the same origin private file system, with no network: this is the
    // property the whole store exists for.
    const offline = cacheOver(new OpfsAssetStore(root), {
      fetch: async () => {
        throw new Error('the second session has no network');
      },
    });
    expect(await offline.load(entry)).toEqual(bytes);
    expect(bucket.urls).toHaveLength(1);
  });

  it('takes the base URL from the manifest unless it is overridden', async () => {
    const bytes = text('melee-asset');
    const entry = entryFor('files/boot/opening.mov', bytes);
    const bucket = fakeBucket();
    const cdn = `https://cdn.example/game/${entry.stored}`;
    bucket.serve(cdn, bytes);

    const cache = cacheFor(manifestWith([entry], 'https://cdn.example/game/'), new MemoryAssetStore(), {
      fetch: bucket.fetch,
      digest: nodeDigest,
    });

    expect(await cache.load(entry)).toEqual(bytes);
    expect(bucket.urls).toEqual([cdn]);
  });
});

describe('sha256Hex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is WebCrypto SHA-256 in the manifest\u2019s own hex format', async () => {
    // The manifest's `sha256` is lowercase hex, so the digest the cache compares against has to
    // be the same thing WebCrypto computes, not a different encoding of it.
    const bytes = text('melee');
    expect(await sha256Hex(bytes)).toBe('c5f5aae9769a367a69eed7b64a203d0a694d2cfbb5809c7556efa1cf5b4027ba');
    expect(await sha256Hex(bytes, nodeDigest)).toBe(await sha256Hex(bytes));
  });

  it('refuses to hand out an unverified asset when WebCrypto is missing', async () => {
    // WebCrypto is required, not optional: without it nothing can be verified, and an
    // unverified asset is worse than no asset.
    vi.stubGlobal('crypto', {});
    await expect(sha256Hex(text('melee'))).rejects.toThrow(AssetIntegrityError);
  });
});
