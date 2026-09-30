/**
 * The disc cache: the 1.36 GiB disc image, downloaded in verified pieces into the origin's own
 * storage, so the spike page does not ask for the file selector again on every run.
 *
 * `scripts/phase0/disc_chunks.py` cuts the disc into pieces and publishes, next to the total
 * size and the disc's own SHA-1, one SHA-256 per piece in order. That manifest is the contract
 * this module works to, and five rules follow from it:
 *
 *  1. **Nothing is written before it is verified.** A piece is hashed on arrival and compared
 *     with its manifest entry *before* one byte reaches storage, so a corrupt download cannot
 *     poison the cache for the next attempt.
 *  2. **A partial download resumes.** The pieces already stored are re-read and re-hashed at
 *     every start, and the file is truncated at the first piece that is missing, short or
 *     corrupt. Length alone certifies nothing: a piece of the right size can hold the wrong
 *     bytes, and a wrong byte in a disc image is a wrong game rather than a cosmetic fault.
 *  3. **A range request is not trusted to have been honoured.** The endpoint is asked for
 *     exactly the missing bytes and must answer `206` with a `Content-Range` naming the bytes
 *     it sent, a body of exactly that length, and bytes whose SHA-256 is the manifest's. A
 *     `200`, an HTML sign-in page, or a body longer than requested is refused before anything
 *     is written: a `200` means the range was ignored, and writing a whole disc into the middle
 *     of a cached file is silent corruption.
 *  4. **One cache per manifest.** The identity of the cache is the hash of the manifest, so a
 *     different disc -- or the same disc cut into different pieces -- does not read the old
 *     bytes.
 *  5. **Free space is asked about before it is needed.** `estimate()` reports free space without
 *     reserving any and `persist()` may be denied, so the download demands the missing bytes
 *     plus a margin and refuses to start when the quota cannot hold them.
 *
 * Storage, network, digest and the storage manager are injectable, so every rule above is
 * asserted in `web/tests/unit/disc-cache.test.ts` without a browser. The browser implementation
 * of `DiscStore` is the dedicated OPFS worker (the next step of PR 4,
 * `docs/PHASE0_DEPLOY_PLAN.md` section 5); this module never touches OPFS itself.
 */

import { sha256Hex, type Digest } from '../assets/cache.js';

/** The digest format `scripts/phase0/disc_chunks.py` publishes for the whole disc. */
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/**
 * The script cuts at 16 MiB. A manifest may not ask for more than this, because exactly one
 * piece is held in memory at a time and a piece larger than the buffer the page will allocate
 * is a memory failure dressed up as a download.
 */
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
/**
 * Demanded on top of the missing bytes. `estimate()` reports free space at the moment it is
 * asked and reserves none of it: another tab, the asset cache or the browser's own bookkeeping
 * can take bytes before the write lands.
 */
const DEFAULT_QUOTA_MARGIN_BYTES = 8 * 1024 * 1024;
/** The tag hashed into the cache identity, so a later format is not mistaken for this one. */
const IDENTITY_TAG = 'melee-disc-cache/1';

/** The manifest document, in the shape `scripts/phase0/disc_chunks.py` writes it. */
export interface DiscManifestDocument {
  readonly size_bytes: number;
  readonly chunk_size_bytes: number;
  readonly sha1: string;
  readonly chunks: readonly string[];
}

/** The same document, validated and in this module's own field names. */
export interface DiscManifest {
  readonly sizeBytes: number;
  readonly chunkSizeBytes: number;
  /** SHA-1 of the whole disc. Part of the identity; not recomputed in the browser. */
  readonly sha1: string;
  /** SHA-256 of each piece, in disc order. */
  readonly chunks: readonly string[];
}

/** The part of a `Response` this module uses. */
export interface DiscResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** What is sent with a piece request: a `Range` header, and the caller's signal. */
export interface DiscRequest {
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal;
}

export type DiscFetch = (url: string, request: DiscRequest) => Promise<DiscResponseLike>;

/**
 * Where the cached bytes live: one file, written front to back.
 *
 * The browser implementation is an OPFS worker holding a single `createSyncAccessHandle()`,
 * which flushes after every piece and closes before the `File` is handed out. `length()` is the
 * number of bytes written *and flushed*: the resume scan trusts nothing else.
 */
export interface DiscStore {
  /** Bytes of the cached disc stored so far, `0` when there is no file yet. */
  length(): Promise<number>;
  /** The `length` bytes at `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Append verified bytes; `offset` must equal the current length. */
  append(offset: number, bytes: Uint8Array): Promise<void>;
  /** Drop everything after `bytes`, so the next append starts there. */
  truncate(bytes: number): Promise<void>;
  /** Close the file and return it, named and typed like the picked one. */
  file(): Promise<File>;
  /** Delete the cached disc. */
  remove(): Promise<void>;
}

/** A store for one cache identity. The worker keeps one file per identity. */
export type DiscStoreFactory = (identity: string) => DiscStore | Promise<DiscStore>;

export interface DiscStorageStatus {
  readonly quota?: number;
  readonly usage?: number;
  readonly persisted: boolean;
}

export interface DiscProgress {
  /** Bytes of the disc verified and stored so far. */
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
}

export interface DiscDownloadOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DiscProgress) => void;
}

export interface DiscCacheOptions {
  /** Where the piece manifest is served. */
  readonly manifestUrl?: string;
  /** Where the disc itself is served, with byte ranges. */
  readonly discUrl?: string;
  readonly fetch?: DiscFetch;
  readonly digest?: Digest;
  readonly estimate?: () => Promise<{ quota?: number; usage?: number }>;
  readonly persisted?: () => Promise<boolean>;
  readonly persist?: () => Promise<boolean>;
  readonly quotaMarginBytes?: number;
}

export class DiscManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscManifestError';
  }
}

/** A request that failed, or an answer that cannot be behind a range request. */
export class DiscFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscFetchError';
  }
}

/** Bytes that are not the bytes the manifest publishes. Nothing has been written. */
export class DiscIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscIntegrityError';
  }
}

export class DiscQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscQuotaError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new DiscManifestError(`${what} must be a positive safe integer`);
  }
  return value;
}

/**
 * Validate a parsed manifest document.
 *
 * The size, the piece size and the number of pieces are one statement written three ways: the
 * pieces must cover the disc exactly, so the count must be the ceiling of the division and the
 * last piece must be the remainder. A document that disagrees with itself is refused here
 * rather than at the end of a 1.36 GB download.
 */
export function parseDiscManifest(value: unknown): DiscManifest {
  if (!isObject(value)) throw new DiscManifestError('the piece manifest must be a JSON object');
  const sizeBytes = requireInteger(value.size_bytes, 'size_bytes');
  const chunkSizeBytes = requireInteger(value.chunk_size_bytes, 'chunk_size_bytes');
  if (chunkSizeBytes > MAX_CHUNK_BYTES) {
    throw new DiscManifestError(
      `chunk_size_bytes is ${chunkSizeBytes}, over the ${MAX_CHUNK_BYTES}-byte limit this page will hold in memory`,
    );
  }
  const sha1 = value.sha1;
  if (typeof sha1 !== 'string' || !SHA1_PATTERN.test(sha1)) {
    throw new DiscManifestError('sha1 must be a lowercase hex SHA-1 of 40 digits');
  }
  const chunks = value.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new DiscManifestError('chunks must be a non-empty array');
  }
  chunks.forEach((digest, index) => {
    if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) {
      throw new DiscManifestError(`chunks[${index}] is not a lowercase hex SHA-256 of 64 digits`);
    }
  });
  const expected = Math.ceil(sizeBytes / chunkSizeBytes);
  if (chunks.length !== expected) {
    throw new DiscManifestError(
      `chunks has ${chunks.length} entries but ${sizeBytes} bytes in ${chunkSizeBytes}-byte pieces is ${expected}`,
    );
  }
  return { sizeBytes, chunkSizeBytes, sha1, chunks: chunks as readonly string[] };
}

/** The length of one piece: the piece size, except for the last piece of the disc. */
export function chunkLength(manifest: DiscManifest, index: number): number {
  return Math.min(manifest.chunkSizeBytes, manifest.sizeBytes - index * manifest.chunkSizeBytes);
}

/** SHA-256 of the validated manifest, lowercase hex: the identity of one cache. */
export async function manifestIdentity(
  manifest: DiscManifest,
  digest: Digest = platformDigest,
): Promise<string> {
  // A canonical form of the fields that decide what the bytes are, in a fixed order, so that
  // key order and unknown extra keys in the document do not change the identity.
  const canonical = JSON.stringify([
    IDENTITY_TAG,
    manifest.sizeBytes,
    manifest.chunkSizeBytes,
    manifest.sha1,
    manifest.chunks,
  ]);
  return sha256Hex(new TextEncoder().encode(canonical), digest);
}

/**
 * The platform's SHA-256, in the shape `sha256Hex` injects.
 *
 * The asset cache has the same three lines privately (`web/src/assets/cache.ts`), and the copy
 * into its own `ArrayBuffer` is not decoration: `crypto.subtle.digest` and `Blob` refuse a view
 * over a `SharedArrayBuffer`, which a `Uint8Array` from some sources is.
 */
const platformDigest: Digest = (algorithm, bytes) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // WebCrypto is required, not optional: without it nothing can be verified, and an
    // unverified disc is worse than no disc.
    return Promise.reject(
      new DiscIntegrityError('crypto.subtle is unavailable: the disc cannot be verified'),
    );
  }
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return subtle.digest(algorithm, copy);
};

function storageManager(): StorageManager | null {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return nav?.storage ?? null;
}

async function platformEstimate(): Promise<{ quota?: number; usage?: number }> {
  const manager = storageManager();
  if (!manager?.estimate) return {};
  try {
    return await manager.estimate();
  } catch {
    // A storage manager that cannot answer is treated as one that has no opinion: refusing to
    // download because `estimate()` failed would be a worse bug than a late quota error.
    return {};
  }
}

async function platformPersisted(): Promise<boolean> {
  const manager = storageManager();
  if (!manager?.persisted) return false;
  try {
    return await manager.persisted();
  } catch {
    return false;
  }
}

async function platformPersist(): Promise<boolean> {
  const manager = storageManager();
  if (!manager?.persist) return false;
  try {
    return await manager.persist();
  } catch {
    return false;
  }
}

interface Resolved {
  readonly manifestUrl: string;
  readonly discUrl: string;
  readonly fetch: DiscFetch;
  readonly digest: Digest;
  readonly estimate: () => Promise<{ quota?: number; usage?: number }>;
  readonly persisted: () => Promise<boolean>;
  readonly persist: () => Promise<boolean>;
  readonly quotaMarginBytes: number;
}

export class DiscCache {
  private readonly options: Resolved;
  private manifestPromise: Promise<DiscManifest> | null = null;
  private identityPromise: Promise<string> | null = null;
  private readonly stores = new Map<string, Promise<DiscStore>>();
  /** The download in flight, if any: there is one file and one writer. */
  private running: Promise<File> | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly storeFor: DiscStoreFactory,
    options: DiscCacheOptions = {},
  ) {
    this.options = {
      manifestUrl: options.manifestUrl ?? '/phase0/disc-chunks',
      discUrl: options.discUrl ?? '/phase0/disc',
      fetch: options.fetch ?? ((url, request) => fetch(url, request)),
      digest: options.digest ?? platformDigest,
      estimate: options.estimate ?? platformEstimate,
      persisted: options.persisted ?? platformPersisted,
      persist: options.persist ?? platformPersist,
      quotaMarginBytes: options.quotaMarginBytes ?? DEFAULT_QUOTA_MARGIN_BYTES,
    };
  }

  /** The manifest, fetched once per instance. */
  manifest(): Promise<DiscManifest> {
    if (!this.manifestPromise) {
      this.manifestPromise = this.fetchManifest().catch((error: unknown) => {
        // A manifest that could not be read is not a manifest: the next call tries again
        // rather than remembering the failure.
        this.manifestPromise = null;
        throw error;
      });
    }
    return this.manifestPromise;
  }

  /** SHA-256 of the manifest: the identity of the cache this instance reads and writes. */
  cacheId(): Promise<string> {
    if (!this.identityPromise) {
      this.identityPromise = this.manifest()
        .then((manifest) => manifestIdentity(manifest, this.options.digest))
        .catch((error: unknown) => {
          this.identityPromise = null;
          throw error;
        });
    }
    return this.identityPromise;
  }

  /**
   * The disc as a `File`, if the whole of it is stored and verified, otherwise `null`.
   *
   * A cache that is not complete is not usable, and the partial file is truncated at the last
   * verified piece on the way out, so the next download resumes from there instead of
   * re-reading bytes that are already known to be wrong.
   */
  async getVerifiedDisc(): Promise<File | null> {
    const manifest = await this.manifest();
    const store = await this.store();
    const verified = await this.verifiedPrefix(manifest, store);
    if (verified !== manifest.sizeBytes) return null;
    if ((await store.length()) !== manifest.sizeBytes) return null;
    return store.file();
  }

  /**
   * Download the missing pieces and return the complete disc.
   *
   * A second call while one is running joins it rather than starting a second writer, and an
   * aborted download leaves the verified prefix in place: the next call resumes from it.
   */
  downloadDisc(options: DiscDownloadOptions = {}): Promise<File> {
    const running = this.running;
    if (running) {
      // The caller's own signal still stops the shared download: there is one download to stop.
      this.chainedAbort(options.signal);
      return running;
    }
    const pending = this.downloadOnce(options).finally(() => {
      this.running = null;
      this.controller = null;
    });
    this.running = pending;
    return pending;
  }

  /** Delete the cached disc, stopping a download in flight first. */
  async deleteDisc(): Promise<void> {
    this.controller?.abort(new DOMException('the disc cache was deleted', 'AbortError'));
    const running = this.running;
    if (running) await running.catch(() => undefined);
    const store = await this.store();
    await store.remove();
  }

  /** What the browser says about the origin's storage, and whether it is persisted. */
  async storageStatus(): Promise<DiscStorageStatus> {
    let estimate: { quota?: number; usage?: number } = {};
    try {
      estimate = await this.options.estimate();
    } catch {
      estimate = {};
    }
    let persisted = false;
    try {
      persisted = await this.options.persisted();
    } catch {
      persisted = false;
    }
    return { quota: estimate.quota, usage: estimate.usage, persisted };
  }

  /** The store for this cache's identity, created once per instance. */
  private store(): Promise<DiscStore> {
    return this.cacheId().then((identity) => {
      let store = this.stores.get(identity);
      if (!store) {
        store = Promise.resolve(this.storeFor(identity));
        this.stores.set(identity, store);
      }
      return store;
    });
  }

  private chainedAbort(signal: AbortSignal | undefined): void {
    if (!signal) return;
    const controller = this.controller;
    if (!controller) return;
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  private async downloadOnce(options: DiscDownloadOptions): Promise<File> {
    const manifest = await this.manifest();
    const store = await this.store();
    const controller = new AbortController();
    this.controller = controller;
    this.chainedAbort(options.signal);
    try {
      const start = await this.verifiedPrefix(manifest, store);
      options.onProgress?.({
        receivedBytes: start,
        totalBytes: manifest.sizeBytes,
        chunkIndex: Math.floor(start / manifest.chunkSizeBytes),
        chunkCount: manifest.chunks.length,
      });
      if (start < manifest.sizeBytes) {
        await this.demandSpace(manifest.sizeBytes - start);
        await this.fetchPieces(manifest, store, start, controller.signal, options.onProgress);
      }
      const length = await store.length();
      if (length !== manifest.sizeBytes) {
        throw new DiscIntegrityError(
          `the cached disc is ${length} bytes, not the ${manifest.sizeBytes} the manifest publishes`,
        );
      }
      return await store.file();
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /**
   * Ask to persist, then refuse to start when the quota cannot hold the missing bytes.
   *
   * `estimate()` does not reserve anything and `persist()` may be denied, so both answers are
   * advisory: the refusal below only happens when the browser states a quota that is too small.
   */
  private async demandSpace(missingBytes: number): Promise<void> {
    // Best effort: a denied `persist()` is not a failed download, it is a cache the browser
    // may evict. `storageStatus()` reports what the browser actually answered.
    try {
      await this.options.persist();
    } catch {
      /* denied, or no storage manager at all */
    }
    let estimate: { quota?: number; usage?: number };
    try {
      estimate = await this.options.estimate();
    } catch {
      // A browser that cannot estimate is treated as one with no opinion: refusing to
      // download because `estimate()` failed is a worse bug than a late quota error.
      return;
    }
    const { quota, usage } = estimate;
    if (quota === undefined) return;
    const needed = missingBytes + this.options.quotaMarginBytes;
    const free = quota - (usage ?? 0);
    if (free < needed) {
      throw new DiscQuotaError(
        `the origin has ${free} bytes free but the download needs ${missingBytes} plus a ` +
          `${this.options.quotaMarginBytes}-byte margin`,
      );
    }
  }

  /**
   * How many bytes of the disc are stored and verified.
   *
   * Every stored piece is re-read and re-hashed, not merely measured: a piece of the right
   * length can hold the wrong bytes. The file is truncated at the first piece that fails, so
   * what is left behind is always a verified prefix.
   */
  private async verifiedPrefix(manifest: DiscManifest, store: DiscStore): Promise<number> {
    const stored = await store.length();
    let offset = 0;
    for (let index = 0; index < manifest.chunks.length; index++) {
      const expected = chunkLength(manifest, index);
      if (stored < offset + expected) break;
      const bytes = await store.read(offset, expected);
      if (bytes.length !== expected) break;
      if ((await sha256Hex(bytes, this.options.digest)) !== manifest.chunks[index]) break;
      offset += expected;
    }
    if (offset !== stored) await store.truncate(offset);
    return offset;
  }

  private async fetchPieces(
    manifest: DiscManifest,
    store: DiscStore,
    start: number,
    signal: AbortSignal,
    onProgress: ((progress: DiscProgress) => void) | undefined,
  ): Promise<void> {
    // `start` is always a piece boundary: `verifiedPrefix` only advances by whole pieces.
    let offset = start;
    for (let index = Math.floor(start / manifest.chunkSizeBytes); index < manifest.chunks.length; index++) {
      if (signal.aborted) throw abortReason(signal);
      const bytes = await this.fetchPiece(manifest, index, offset, signal);
      await store.append(offset, bytes);
      offset += bytes.length;
      onProgress?.({
        receivedBytes: offset,
        totalBytes: manifest.sizeBytes,
        chunkIndex: index,
        chunkCount: manifest.chunks.length,
      });
    }
  }

  /**
   * One piece, verified, or nothing at all.
   *
   * The order is the point: status, `Content-Range`, length and SHA-256 are all checked before
   * the caller is given the bytes, and the caller writes them only after that.
   */
  private async fetchPiece(
    manifest: DiscManifest,
    index: number,
    offset: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const expected = chunkLength(manifest, index);
    const end = offset + expected - 1;
    const range = `bytes=${offset}-${end}`;
    const url = this.options.discUrl;
    let response: DiscResponseLike;
    try {
      response = await this.options.fetch(url, { headers: { Range: range }, signal });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new DiscFetchError(`Fetching ${url} ${range} failed: ${(error as Error).message}`);
    }
    if (response.status !== 206) {
      throw new DiscFetchError(
        response.status === 200
          ? `${url} answered 200 to ${range}: the endpoint ignored the range request`
          : `${url} answered ${response.status} to ${range}`,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      // A 206 is not a promise: an interception page can answer one. HTML is never a disc.
      throw new DiscFetchError(`${url} answered ${range} with ${contentType}, not disc bytes`);
    }
    const wanted = `bytes ${offset}-${end}/${manifest.sizeBytes}`;
    const contentRange = response.headers.get('content-range');
    if (contentRange !== wanted) {
      throw new DiscFetchError(`${url} ${range}: Content-Range is ${contentRange}, not ${wanted}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== expected) {
      throw new DiscIntegrityError(
        `${url} ${range}: expected ${expected} bytes, received ${bytes.length}`,
      );
    }
    const actual = await sha256Hex(bytes, this.options.digest);
    if (actual !== manifest.chunks[index]) {
      throw new DiscIntegrityError(
        `${url} ${range}: piece ${index} hashes to ${actual}, not ${manifest.chunks[index]}`,
      );
    }
    return bytes;
  }

  private async fetchManifest(): Promise<DiscManifest> {
    const url = this.options.manifestUrl;
    let response: DiscResponseLike;
    try {
      response = await this.options.fetch(url, { headers: { Accept: 'application/json' } });
    } catch (error) {
      throw new DiscManifestError(`Fetching ${url} failed: ${(error as Error).message}`);
    }
    if (response.status !== 200) {
      throw new DiscManifestError(`Fetching ${url} failed with status ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      throw new DiscManifestError(`${url} answered with ${contentType}, which is a page and not a manifest`);
    }
    const text = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new DiscManifestError(`${url} is not valid JSON: ${(error as Error).message}`);
    }
    return parseDiscManifest(parsed);
  }
}

/** The error an aborted fetch or a stopped loop reports, so callers can tell it from a failure. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('the download was aborted', 'AbortError');
}
