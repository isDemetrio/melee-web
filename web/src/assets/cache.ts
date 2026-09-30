/**
 * The content-addressed asset cache: manifest in, bytes out, verified.
 *
 * A game asset is fetched once, checked against the SHA-256 the manifest publishes, stored
 * under that hash, and served from the store on every later request. Three properties are
 * load-bearing and each has a test:
 *
 *  1. **Nothing reaches the simulation unverified.** The bytes are hashed after they arrive
 *     and before they are stored; a mismatch throws and stores nothing. A wrong asset in this
 *     project is not a cosmetic bug: a corrupted texture or character table changes simulation
 *     state, and a desync looks exactly like a netcode fault.
 *  2. **A hit costs no network.** The second call for the same asset does not fetch. This is
 *     the whole point of the cache: the asset tree is far larger than one match needs, and a
 *     reload must not re-download it.
 *  3. **A failed write is not a failed load.** If the store refuses (quota, a closed OPFS
 *     directory), the bytes are still returned to the caller. Caching is an optimisation;
 *     refusing to boot because the cache is full would be a worse bug than re-fetching.
 *
 * What this does not do yet: hand the bytes to the WASM core. There is no core -- there is no
 * disc image, so there is no `melee.wasm` (`docs/OPEN_QUESTIONS.md` Q1) -- so the last step of
 * the pipeline is a `load()` that returns the bytes and a worker that does not exist. Writing
 * anything about a heap write here would be a claim nothing verifies.
 *
 * The fetcher and the digest are injectable so the unit tests can drive a fake network with
 * real hashing; both default to the platform's own (`fetch`, `crypto.subtle.digest`).
 */

import { AssetStoreError, type AssetStore } from './store.js';
import type { AssetEntry, AssetManifest } from '../types.js';

/** The part of a `Response` this module uses. */
export interface AssetResponseLike {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type AssetFetch = (url: string) => Promise<AssetResponseLike>;

/** `crypto.subtle.digest`, narrowed to what is used. */
export type Digest = (algorithm: 'SHA-256', bytes: Uint8Array) => Promise<ArrayBuffer>;

export class AssetIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetIntegrityError';
  }
}

/** A fetch that failed, or answered with a status the manifest cannot be behind. */
export class AssetFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetFetchError';
  }
}

/** SHA-256 of some bytes, lowercase hex. */
export async function sha256Hex(bytes: Uint8Array, digest: Digest = defaultDigest): Promise<string> {
  const hashed = new Uint8Array(await digest('SHA-256', bytes));
  let out = '';
  for (const byte of hashed) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * A copy of the bytes, over its own `ArrayBuffer`.
 *
 * `crypto.subtle.digest` and `Blob` take a `BufferSource`, and a `Uint8Array` may be a view
 * over a `SharedArrayBuffer` or over a larger buffer, which those APIs do not accept. Copying
 * also means a caller mutating its buffer while the hash is running cannot change the result.
 * It costs one pass over the asset, on the paths that already hash it.
 *
 * The return type is deliberately inferred: annotating it as `Uint8Array` would widen it back
 * to a view over any `ArrayBufferLike` and the `BufferSource` call sites would stop compiling
 * on the TypeScript versions that made the typed-array DOM types generic.
 */
function copyBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

function defaultDigest(algorithm: 'SHA-256', bytes: Uint8Array): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // WebCrypto is required, not optional: without it the cache cannot verify what it
    // received, and an unverified asset is worse than no asset.
    return Promise.reject(new AssetIntegrityError('crypto.subtle is unavailable: cannot verify assets'));
  }
  return subtle.digest(algorithm, copyBytes(bytes));
}

function defaultFetch(url: string): Promise<AssetResponseLike> {
  return fetch(url);
}

/**
 * One gzip member. `DecompressionStream` is in every browser that has OPFS and in Node 18+,
 * which is what the unit tests run on; a manifest that says `gzip` and a platform that cannot
 * decode it is a hard error rather than a silently truncated asset.
 */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([copyBytes(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface AssetCacheOptions {
  /** Origin of the asset bucket. Defaults to the manifest's own `baseUrl`. */
  readonly baseUrl?: string;
  readonly fetch?: AssetFetch;
  readonly digest?: Digest;
  /**
   * Re-hash every cache hit. Off by default: the file name *is* the hash, so a hit is trusted
   * by length, and re-hashing on the hot path costs a pass over the whole file. A truncated
   * file -- what quota eviction actually produces -- is caught by the length check either way.
   * The settings screen can turn it on to diagnose a suspicious install.
   */
  readonly verifyOnRead?: boolean;
}

interface Resolved {
  readonly baseUrl: string;
  readonly fetch: AssetFetch;
  readonly digest: Digest;
  readonly verifyOnRead: boolean;
}

export class AssetCache {
  private readonly options: Resolved;
  /** In-flight loads, so two callers asking for the same asset cause one fetch. */
  private readonly inFlight = new Map<string, Promise<Uint8Array>>();

  constructor(
    private readonly store: AssetStore,
    options: AssetCacheOptions = {},
  ) {
    this.options = {
      baseUrl: options.baseUrl ?? '',
      fetch: options.fetch ?? defaultFetch,
      digest: options.digest ?? defaultDigest,
      verifyOnRead: options.verifyOnRead ?? false,
    };
  }

  /** True when the asset is already cached and its length matches the manifest. */
  async has(entry: AssetEntry): Promise<boolean> {
    const bytes = await this.store.read(entry.stored);
    return bytes !== null && bytes.length === entry.size;
  }

  /**
   * The asset's bytes: from the store when they are there, from the network when they are not.
   *
   * Concurrent calls for the same asset share one load. Without that, a screen that requests a
   * stage and its music at the same time downloads both twice and stores the second copy over
   * the first.
   */
  async load(entry: AssetEntry): Promise<Uint8Array> {
    const running = this.inFlight.get(entry.stored);
    if (running) return running;
    const pending = this.loadOnce(entry).finally(() => {
      this.inFlight.delete(entry.stored);
    });
    this.inFlight.set(entry.stored, pending);
    return pending;
  }

  /** Drop one asset from the store, so the next `load` fetches it again. */
  async evict(entry: AssetEntry): Promise<void> {
    await this.store.delete(entry.stored);
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }

  private async loadOnce(entry: AssetEntry): Promise<Uint8Array> {
    const cached = await this.readCached(entry);
    if (cached) return cached;

    const fetched = await this.fetchVerified(entry);
    await this.storeBestEffort(entry, fetched);
    return fetched;
  }

  /** A usable cache hit, or null: absent, truncated, or (when asked) not matching its hash. */
  private async readCached(entry: AssetEntry): Promise<Uint8Array | null> {
    let bytes: Uint8Array | null;
    try {
      bytes = await this.store.read(entry.stored);
    } catch (error) {
      if (error instanceof AssetStoreError) throw error;
      // A store that cannot be read is treated as an empty one: the network is still there.
      return null;
    }
    if (!bytes) return null;
    if (bytes.length !== entry.size) {
      // Self-healing: a file whose length is not what the manifest says cannot be what its
      // name claims, so it is dropped rather than served.
      await this.store.delete(entry.stored).catch(() => undefined);
      return null;
    }
    if (this.options.verifyOnRead) {
      const actual = await sha256Hex(bytes, this.options.digest);
      if (actual !== entry.sha256) {
        await this.store.delete(entry.stored).catch(() => undefined);
        return null;
      }
    }
    return bytes;
  }

  private async fetchVerified(entry: AssetEntry): Promise<Uint8Array> {
    const url = `${this.options.baseUrl}${entry.stored}`;
    let response: AssetResponseLike;
    try {
      response = await this.options.fetch(url);
    } catch (error) {
      throw new AssetFetchError(`Fetching ${url} failed: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new AssetFetchError(`Fetching ${url} failed with status ${response.status}`);
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    const bytes = entry.encoding === 'gzip' ? await gunzip(raw) : raw;
    if (bytes.length !== entry.size) {
      throw new AssetIntegrityError(
        `${entry.path}: expected ${entry.size} bytes, received ${bytes.length}`,
      );
    }
    const actual = await sha256Hex(bytes, this.options.digest);
    if (actual !== entry.sha256) {
      throw new AssetIntegrityError(
        `${entry.path}: expected sha256 ${entry.sha256}, received ${actual}`,
      );
    }
    return bytes;
  }

  /** Store the bytes, and carry on if the store refuses. */
  private async storeBestEffort(entry: AssetEntry, bytes: Uint8Array): Promise<void> {
    try {
      await this.store.write(entry.stored, bytes);
    } catch (error) {
      if (error instanceof AssetStoreError) throw error;
      // Quota, a revoked directory, a closed stream: the caller still gets its bytes.
    }
  }
}

/** A cache for one manifest, with the manifest's own base URL unless overridden. */
export function cacheFor(
  manifest: AssetManifest,
  store: AssetStore,
  options: AssetCacheOptions = {},
): AssetCache {
  return new AssetCache(store, { baseUrl: manifest.baseUrl, ...options });
}
