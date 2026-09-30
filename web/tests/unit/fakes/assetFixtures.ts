/**
 * Fixtures for the manifest and cache tests: real hashes, a fake bucket.
 *
 * The cache's whole job is to compare bytes against a published hash, so a fake digest would
 * test nothing. These helpers hash with `node:crypto`, which is the same SHA-256 WebCrypto
 * computes, and `nodeDigest` is that hash in the shape `AssetCache` injects. A test that wants
 * the platform's own path passes no digest at all and uses `crypto.subtle` instead.
 *
 * `fakeNetwork` is a bucket with a route per URL: it records the URLs that were requested, so
 * "a cache hit costs no network" is asserted by counting requests rather than by trusting the
 * return value.
 */

import { createHash } from 'node:crypto';
import type { AssetEntry, AssetManifest } from '../../../src/types.js';
import type { AssetFetch, AssetResponseLike, Digest } from '../../../src/assets/cache.js';

/** SHA-256 of some bytes, lowercase hex: the manifest's own format. */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 through `node:crypto`, in the shape `AssetCache` injects. */
export const nodeDigest: Digest = async (_algorithm, bytes) => {
  const hash = createHash('sha256').update(bytes).digest();
  const out = new ArrayBuffer(hash.length);
  new Uint8Array(out).set(hash);
  return out;
};

/** A copy of the bytes as an `ArrayBuffer`, which is what a `Response` hands back. */
export function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * A manifest entry for some bytes, hashed for real.
 *
 * `overrides` exists for the tests that need a *wrong* entry: a hash that does not match, a
 * size that lies, an encoding the object does not use.
 */
export function entryFor(
  path: string,
  bytes: Uint8Array,
  overrides: Partial<AssetEntry> = {},
): AssetEntry {
  const sha256 = sha256Of(bytes);
  return {
    path,
    sha256,
    size: bytes.length,
    group: 'boot',
    stored: `${sha256}.bin`,
    encoding: 'identity',
    ...overrides,
  };
}

export function manifestWith(
  entries: readonly AssetEntry[],
  baseUrl = 'https://assets.example/',
): AssetManifest {
  return { version: '1', generatedAt: '2026-09-30T00:00:00Z', baseUrl, entries };
}

export interface FakeBucket {
  readonly fetch: AssetFetch;
  /** Every URL that was requested, in order: the network counter. */
  readonly urls: readonly string[];
  /** Answer 200 with these bytes. */
  serve(url: string, bytes: Uint8Array): void;
  /** Answer with a status the manifest cannot be behind. */
  refuse(url: string, status: number): void;
  /** Fail before a response exists, the way an offline browser does. */
  breakWith(url: string, error: Error): void;
}

export function fakeBucket(): FakeBucket {
  const routes = new Map<string, () => Promise<AssetResponseLike>>();
  const urls: string[] = [];
  return {
    urls,
    async fetch(url: string) {
      urls.push(url);
      const route = routes.get(url);
      if (!route) throw new Error(`the fake bucket has no route for ${url}`);
      return route();
    },
    serve(url, bytes) {
      routes.set(url, async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => bufferOf(bytes),
      }));
    },
    refuse(url, status) {
      routes.set(url, async () => ({
        ok: false,
        status,
        arrayBuffer: async () => new ArrayBuffer(0),
      }));
    },
    breakWith(url, error) {
      routes.set(url, async () => {
        throw error;
      });
    },
  };
}

/** A plain manifest document, as `scripts/make_manifest.py` would write it. */
export function manifestDocument(entries: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    version: '1',
    generatedAt: '2026-09-30T00:00:00Z',
    baseUrl: 'https://assets.example/',
    entries,
  };
}

/** One plain entry object, for the parser tests that need a malformed one. */
export function entryDocument(
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const sha256 = sha256Of(bytes);
  return {
    path: 'files/audio/bgm/01.mus',
    sha256,
    size: bytes.length,
    group: 'music',
    stored: `${sha256}.bin`,
    encoding: 'identity',
    ...overrides,
  };
}
