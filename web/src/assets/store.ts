/**
 * Where cached game assets live.
 *
 * The cache is content-addressed: a file is stored under the SHA-256 of its *uncompressed*
 * bytes (`AssetEntry.stored`, `web/src/types.ts`), so the name of a file is a statement about
 * its contents. That is what makes a cache hit trustworthy without re-reading the manifest,
 * and it is why two identical files occupy one slot.
 *
 * OPFS is the real store (it is on the disk, it survives a reload, and it is the only place a
 * multi-hundred-megabyte asset tree can live in a browser). `MemoryAssetStore` is the fallback
 * for the cases where OPFS is not there: a browser without `navigator.storage.getDirectory`
 * (the capability report already flags it, `web/src/platform/capabilities.ts`), a private
 * window that refuses to open the origin directory, or a unit test. A fallback that keeps the
 * session working with less caching beats a shell that refuses to start.
 *
 * The OPFS handles are described structurally rather than as `FileSystemDirectoryHandle`, so
 * a test can drive the store with a fake that obeys the same contract (and so the module
 * compiles without the DOM lib). Nothing here touches `navigator` except
 * `defaultOpfsRoot()`, which the tests replace.
 */

/** One writable file, as much of `FileSystemWritableFileStream` as this module uses. */
export interface OpfsWritableLike {
  // `Uint8Array` rather than `BufferSource`: the real stream accepts both, and naming the
  // concrete type keeps this compiling across TypeScript versions where the array-like
  // DOM types became generic.
  write(data: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
}

/** One file handle, as much of `FileSystemFileHandle` as this module uses. */
export interface OpfsFileHandleLike {
  getFile(): Promise<Blob>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableLike>;
}

/** One directory handle, as much of `FileSystemDirectoryHandle` as this module uses. */
export interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The directory inside the origin private file system that holds the asset blobs. */
export const ASSET_DIRECTORY = 'assets';

/**
 * A key is a manifest `stored` value: the SHA-256 of the uncompressed bytes and `.bin`.
 * Anything else is refused before it reaches the file system, because these names are the
 * only strings from the network that end up in a path.
 */
export const ASSET_KEY_PATTERN = /^[0-9a-f]{64}\.bin$/;

export class AssetStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetStoreError';
  }
}

export interface AssetStore {
  /** True when the key is present. */
  has(key: string): Promise<boolean>;
  /** The stored bytes, or null when the key is absent. */
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Drop every cached asset. */
  clear(): Promise<void>;
}

function assertKey(key: string): void {
  if (!ASSET_KEY_PATTERN.test(key)) {
    throw new AssetStoreError(`Refusing a cache key that is not a content hash: ${key}`);
  }
}

/**
 * `true` for the exception OPFS throws when a name does not exist.
 *
 * Matched on the name rather than with `instanceof DOMException`, because that class is not
 * present in every environment this module is loaded in (Node without the DOM lib, older
 * browsers) and a missing-name error must never be reported as a broken cache.
 */
export function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'NotFoundError';
}

/**
 * The origin private file system's root directory, or null when the browser has none.
 *
 * Returned as a function so that the existence check and the (possibly throwing) call are
 * separate: `navigator.storage.getDirectory` can be present and still reject.
 */
export function defaultOpfsRoot(): (() => Promise<OpfsDirectoryLike>) | null {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const storage = nav && 'storage' in nav
    ? (nav.storage as { getDirectory?: () => Promise<unknown> } | undefined)
    : null;
  if (!storage?.getDirectory) return null;
  const getDirectory = storage.getDirectory.bind(storage);
  return () => getDirectory() as Promise<OpfsDirectoryLike>;
}

/** OPFS-backed store. Every blob is one file named by its own hash. */
export class OpfsAssetStore implements AssetStore {
  constructor(private readonly root: OpfsDirectoryLike) {}

  private async directory(create: boolean): Promise<OpfsDirectoryLike> {
    return this.root.getDirectoryHandle(ASSET_DIRECTORY, { create });
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    try {
      const directory = await this.directory(false);
      await directory.getFileHandle(key);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async read(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    let handle: OpfsFileHandleLike;
    try {
      const directory = await this.directory(false);
      handle = await directory.getFileHandle(key);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    assertKey(key);
    const directory = await this.directory(true);
    const handle = await directory.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    // OPFS buffers until close(), so a crash mid-write leaves no half file under a hash
    // that claims its contents.
    await writable.write(bytes);
    await writable.close();
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    try {
      const directory = await this.directory(false);
      await directory.removeEntry(key);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.root.removeEntry(ASSET_DIRECTORY, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

/** In-memory store: the fallback, and what the unit tests compare OPFS against. */
export class MemoryAssetStore implements AssetStore {
  private readonly files = new Map<string, Uint8Array>();

  get size(): number {
    return this.files.size;
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    return this.files.has(key);
  }

  async read(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    const bytes = this.files.get(key);
    // A copy, so a caller that mutates what it got cannot corrupt the cache.
    return bytes ? bytes.slice() : null;
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    assertKey(key);
    this.files.set(key, bytes.slice());
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    this.files.delete(key);
  }

  async clear(): Promise<void> {
    this.files.clear();
  }
}

/**
 * OPFS when the browser has it, memory otherwise. Never throws: a cache that cannot open
 * its directory is a cache that works without persistence, not a failed page load.
 */
export async function createAssetStore(): Promise<AssetStore> {
  const root = defaultOpfsRoot();
  if (!root) return new MemoryAssetStore();
  try {
    return new OpfsAssetStore(await root());
  } catch {
    return new MemoryAssetStore();
  }
}
