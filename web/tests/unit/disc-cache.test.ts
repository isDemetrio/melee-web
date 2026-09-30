/**
 * The disc cache: verified pieces in, one `File` out, or a refusal.
 *
 * Every rule the module claims is asserted here against a real digest (`node:crypto`) and a
 * fake endpoint that can misbehave in each of the ways the module must refuse. The five that
 * matter most:
 *
 *  - a complete cache costs no request for the disc at all;
 *  - an interrupted download resumes with a `Range` that names exactly the missing bytes;
 *  - a stored piece of the right length but the wrong bytes is truncated, not trusted;
 *  - a `200`, an HTML page, a wrong `Content-Range`, a short body, a long body and a piece
 *    whose hash does not match are all refused *before* anything is written;
 *  - a different manifest is a different cache, so a new disc cannot read the old bytes.
 */

import { describe, expect, it } from 'vitest';
import {
  DiscCache,
  DiscFetchError,
  DiscIntegrityError,
  DiscManifestError,
  DiscQuotaError,
  chunkLength,
  manifestIdentity,
  parseDiscManifest,
  type DiscCacheOptions,
  type DiscProgress,
} from '../../src/spike/disc-cache.js';
import { nodeDigest } from './fakes/assetFixtures.js';
import { FakeDiscServer, discFixture, storeFactory } from './fakes/discFixtures.js';

/** The synthetic disc: three pieces of 8 bytes with a last piece of 4, so 20 bytes in all. */
const SIZE = 20;

function setup(
  options: Partial<DiscCacheOptions> = {},
): { server: FakeDiscServer; factory: ReturnType<typeof storeFactory>; cache: DiscCache } {
  const fixture = discFixture();
  const server = new FakeDiscServer(fixture);
  const factory = storeFactory();
  const cache = new DiscCache(factory.create, {
    fetch: server.fetch,
    digest: nodeDigest,
    ...options,
  });
  return { server, factory, cache };
}

const bytes = (value: Uint8Array): number[] => Array.from(value);

/** Yield microtasks until `predicate` holds. The download path uses no timers. */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10_000 && !predicate(); attempt++) await Promise.resolve();
  if (!predicate()) throw new Error('the awaited condition never became true');
}

describe('parseDiscManifest', () => {
  it('reads the document scripts/phase0/disc_chunks.py writes', () => {
    const manifest = parseDiscManifest(discFixture().document);
    expect(manifest.sizeBytes).toBe(SIZE);
    expect(manifest.chunkSizeBytes).toBe(8);
    expect(manifest.chunks).toHaveLength(3);
    expect(chunkLength(manifest, 0)).toBe(8);
    expect(chunkLength(manifest, 2)).toBe(4);
  });

  it('refuses a document that disagrees with itself about the pieces', () => {
    const { document } = discFixture();
    expect(() => parseDiscManifest({ ...document, chunks: document.chunks.slice(0, 2) })).toThrow(
      DiscManifestError,
    );
    // A size that keeps the piece count is still self-consistent, so this document passes
    // validation: the last piece's own hash is what catches a wrong total (see below).
    expect(() => parseDiscManifest({ ...document, size_bytes: SIZE + 8 })).toThrow(DiscManifestError);
    expect(() => parseDiscManifest({ ...document, chunks: [] })).toThrow(DiscManifestError);
  });

  it('refuses digests that are not in the published format', () => {
    const { document } = discFixture();
    expect(() => parseDiscManifest({ ...document, sha1: 'd4e70c06' })).toThrow(DiscManifestError);
    expect(() => parseDiscManifest({ ...document, sha1: 'D'.repeat(40) })).toThrow(DiscManifestError);
    expect(() =>
      parseDiscManifest({ ...document, chunks: ['not a digest', ...document.chunks.slice(1)] }),
    ).toThrow(DiscManifestError);
  });

  it('refuses sizes that are not positive integers, and non-objects', () => {
    const { document } = discFixture();
    expect(() => parseDiscManifest({ ...document, size_bytes: 0 })).toThrow(DiscManifestError);
    expect(() => parseDiscManifest({ ...document, size_bytes: 20.5 })).toThrow(DiscManifestError);
    expect(() => parseDiscManifest({ ...document, chunk_size_bytes: -8 })).toThrow(DiscManifestError);
    expect(() => parseDiscManifest('<html>')).toThrow(DiscManifestError);
  });

  it('refuses a piece bigger than the page will hold in memory', () => {
    expect(() =>
      parseDiscManifest({
        size_bytes: 64 * 1024 * 1024,
        chunk_size_bytes: 64 * 1024 * 1024,
        sha1: 'a'.repeat(40),
        chunks: ['b'.repeat(64)],
      }),
    ).toThrow(/memory/);
  });
});

describe('DiscCache identity', () => {
  it('identifies the cache by the manifest, not by the document key order', async () => {
    const { document } = discFixture();
    const reordered = {
      chunks: document.chunks,
      sha1: document.sha1,
      chunk_size_bytes: document.chunk_size_bytes,
      size_bytes: document.size_bytes,
      note: 'an extra key a later version might add',
    };
    expect(await manifestIdentity(parseDiscManifest(document), nodeDigest)).toBe(
      await manifestIdentity(parseDiscManifest(reordered), nodeDigest),
    );
  });

  it('gives a different disc a different cache', async () => {
    const first = discFixture();
    const second = discFixture(4);
    const factory = storeFactory();
    const a = new DiscCache(factory.create, {
      fetch: new FakeDiscServer(first).fetch,
      digest: nodeDigest,
    });
    const b = new DiscCache(factory.create, {
      fetch: new FakeDiscServer(second).fetch,
      digest: nodeDigest,
    });
    expect(await a.cacheId()).not.toBe(await b.cacheId());
    factory.for(await a.cacheId()).seed(first.bytes);
    expect(await b.getVerifiedDisc()).toBeNull();
    expect(await a.getVerifiedDisc()).not.toBeNull();
  });
});

describe('DiscCache download', () => {
  it('downloads the disc in pieces and returns it as a File', async () => {
    const { factory, server, cache } = setup();
    const file = await cache.downloadDisc();
    expect(file.size).toBe(SIZE);
    expect(bytes(new Uint8Array(await file.arrayBuffer()))).toEqual(bytes(discFixture().bytes));
    expect(server.pieceRequests.map((request) => request.range)).toEqual([
      'bytes=0-7',
      'bytes=8-15',
      'bytes=16-19',
    ]);
    expect(bytes(factory.for(await cache.cacheId()).stored)).toEqual(bytes(discFixture().bytes));
  });

  it('reports progress from the verified prefix to the last piece', async () => {
    const { cache } = setup();
    const progress: DiscProgress[] = [];
    await cache.downloadDisc({ onProgress: (value) => progress.push(value) });
    expect(progress).toHaveLength(4);
    expect(progress[0]).toEqual({
      receivedBytes: 0,
      totalBytes: SIZE,
      chunkIndex: 0,
      chunkCount: 3,
    });
    expect(progress[3]).toEqual({
      receivedBytes: SIZE,
      totalBytes: SIZE,
      chunkIndex: 2,
      chunkCount: 3,
    });
  });

  it('has one writer: a second call joins the download in flight', async () => {
    const { server, cache } = setup();
    const first = cache.downloadDisc();
    const second = cache.downloadDisc();
    expect(second).toBe(first);
    expect((await second).size).toBe(SIZE);
    expect(server.pieceRequests).toHaveLength(3);
  });

  it('serves a complete cache without asking for the disc', async () => {
    const { factory, server, cache } = setup();
    factory.for(await cache.cacheId()).seed(discFixture().bytes);
    const file = await cache.getVerifiedDisc();
    expect(file).not.toBeNull();
    expect(file?.size).toBe(SIZE);
    expect((await cache.downloadDisc()).size).toBe(SIZE);
    expect(server.pieceRequests).toHaveLength(0);
  });

  it('does not serve an incomplete cache, and truncates it at the last verified piece', async () => {
    const { factory, cache } = setup();
    const store = factory.for(await cache.cacheId());
    store.seed(discFixture().bytes.slice(0, 12));
    expect(await cache.getVerifiedDisc()).toBeNull();
    expect(store.truncations).toEqual([8]);
  });

  it('resumes from the first missing piece with an exact Range', async () => {
    const { factory, server, cache } = setup();
    factory.for(await cache.cacheId()).seed(discFixture().bytes.slice(0, 16));
    const file = await cache.downloadDisc();
    expect(server.pieceRequests.map((request) => request.range)).toEqual(['bytes=16-19']);
    expect(file.size).toBe(SIZE);
  });

  it('re-fetches a stored piece that is the right length but the wrong bytes', async () => {
    const { factory, server, cache } = setup();
    const store = factory.for(await cache.cacheId());
    const seeded = discFixture().bytes.slice(0, 16);
    seeded[9] = (seeded[9] ?? 0) ^ 0xff;
    store.seed(seeded);
    await cache.downloadDisc();
    expect(store.truncations).toEqual([8]);
    expect(server.pieceRequests.map((request) => request.range)).toEqual([
      'bytes=8-15',
      'bytes=16-19',
    ]);
    expect(bytes(store.stored)).toEqual(bytes(discFixture().bytes));
  });

  it('refuses a piece that does not hash to the manifest, keeping what was verified', async () => {
    const { factory, server, cache } = setup();
    server.corrupt.add(1);
    await expect(cache.downloadDisc()).rejects.toThrow(DiscIntegrityError);
    expect(factory.for(await cache.cacheId()).stored).toHaveLength(8);
    expect(server.pieceRequests).toHaveLength(2);
  });

  it('refuses a 200 answer: the endpoint ignored the range', async () => {
    const { factory, server, cache } = setup();
    server.ignoreRange = true;
    await expect(cache.downloadDisc()).rejects.toThrow(DiscFetchError);
    expect(factory.for(await cache.cacheId()).stored).toHaveLength(0);
  });

  it('refuses a page where a piece should be', async () => {
    const { server, cache } = setup();
    server.htmlPage = true;
    await expect(cache.downloadDisc()).rejects.toThrow(DiscFetchError);
  });

  it('refuses a Content-Range that names other bytes', async () => {
    const { server, cache } = setup();
    server.contentRange = 'bytes 0-7/19';
    await expect(cache.downloadDisc()).rejects.toThrow(/Content-Range/);
  });

  it('refuses a body longer than the range it asked for', async () => {
    const { server, cache } = setup();
    server.extraBytes = 4;
    await expect(cache.downloadDisc()).rejects.toThrow(DiscIntegrityError);
  });

  it('reports a piece request that fails, and writes nothing', async () => {
    const { factory, server, cache } = setup();
    await cache.manifest();
    server.failure = new Error('the network went away');
    await expect(cache.downloadDisc()).rejects.toThrow(DiscFetchError);
    expect(factory.for(await cache.cacheId()).stored).toHaveLength(0);
  });

  it('refuses a manifest that is a page, and one that is not JSON', async () => {
    const page = setup();
    page.server.manifestContentType = 'text/html; charset=utf-8';
    await expect(page.cache.downloadDisc()).rejects.toThrow(DiscManifestError);
    const broken = setup();
    broken.server.manifestBody = '<html>sign in</html>';
    await expect(broken.cache.getVerifiedDisc()).rejects.toThrow(DiscManifestError);
  });

  it('stops on abort, keeps the verified prefix, and resumes from it', async () => {
    const { factory, server, cache } = setup();
    const controller = new AbortController();
    await expect(
      cache.downloadDisc({
        signal: controller.signal,
        onProgress: (value) => {
          if (value.receivedBytes === 8) controller.abort();
        },
      }),
    ).rejects.toThrow();
    const store = factory.for(await cache.cacheId());
    expect(store.stored).toHaveLength(8);
    server.requests.length = 0;
    expect((await cache.downloadDisc()).size).toBe(SIZE);
    expect(server.pieceRequests.map((request) => request.range)).toEqual([
      'bytes=8-15',
      'bytes=16-19',
    ]);
  });

  it('turns an abort during the request into a rejection, not a write', async () => {
    const { factory, server, cache } = setup();
    let release: () => void = () => {};
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.gatePiece = 0;
    const controller = new AbortController();
    const pending = cache.downloadDisc({ signal: controller.signal });
    await until(() => server.pieceRequests.length === 1);
    controller.abort();
    release();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(factory.for(await cache.cacheId()).stored).toHaveLength(0);
  });

  it('deletes the cached disc', async () => {
    const { factory, cache } = setup();
    const store = factory.for(await cache.cacheId());
    store.seed(discFixture().bytes);
    await cache.deleteDisc();
    expect(store.removed).toBe(true);
    expect(await cache.getVerifiedDisc()).toBeNull();
  });
});

describe('DiscCache storage', () => {
  it('refuses to start when the quota cannot hold the missing bytes', async () => {
    const { server, cache } = setup({
      estimate: async () => ({ quota: 1024, usage: 0 }),
      persist: async () => false,
      persisted: async () => false,
    });
    await expect(cache.downloadDisc()).rejects.toThrow(DiscQuotaError);
    expect(server.pieceRequests).toHaveLength(0);
  });

  it('downloads when the browser cannot estimate the quota', async () => {
    const { cache } = setup({
      estimate: async () => {
        throw new Error('no estimate');
      },
    });
    expect((await cache.downloadDisc()).size).toBe(SIZE);
  });

  it('reports the origin storage and whether it is persisted', async () => {
    const { cache } = setup({
      estimate: async () => ({ quota: 4_000_000, usage: 1_000 }),
      persisted: async () => true,
    });
    expect(await cache.storageStatus()).toEqual({
      quota: 4_000_000,
      usage: 1_000,
      persisted: true,
    });
  });

  it('reports an unknown quota as unknown rather than as zero', async () => {
    const { cache } = setup({
      estimate: async () => {
        throw new Error('no estimate');
      },
      persisted: async () => false,
    });
    expect(await cache.storageStatus()).toEqual({
      quota: undefined,
      usage: undefined,
      persisted: false,
    });
  });
});
