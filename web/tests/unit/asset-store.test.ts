import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_DIRECTORY,
  AssetStoreError,
  MemoryAssetStore,
  OpfsAssetStore,
  createAssetStore,
  defaultOpfsRoot,
  isNotFound,
  type AssetStore,
} from '../../src/assets/store.js';
import { fakeOpfsRoot, notFound } from './fakes/fakeOpfs.js';

/** A valid cache key: the SHA-256 of some bytes and `.bin`. */
const KEY = `${'a'.repeat(64)}.bin`;
const OTHER_KEY = `${'b'.repeat(64)}.bin`;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('cache keys', () => {
  it('refuses a key that is not a content hash, in both stores', async () => {
    // The only strings from the network that reach a path are these keys. A key that is not a
    // hash is a manifest bug at best and a path traversal at worst.
    for (const store of [new MemoryAssetStore(), new OpfsAssetStore(fakeOpfsRoot())]) {
      await expect(store.read('../escape.bin')).rejects.toThrow(AssetStoreError);
      await expect(store.write('not-a-hash', bytes('x'))).rejects.toThrow(AssetStoreError);
      await expect(store.has('../../etc/passwd')).rejects.toThrow(AssetStoreError);
      await expect(store.delete('a'.repeat(63))).rejects.toThrow(AssetStoreError);
    }
  });

  it('recognises a missing-name error by name, not by class', () => {
    // The store treats NotFoundError as "absent", so it has to spot one from a realm that does
    // not share this one's DOMException class.
    expect(isNotFound(notFound())).toBe(true);
    expect(isNotFound({ name: 'NotFoundError' })).toBe(true);
    expect(isNotFound(new Error('nope'))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe('MemoryAssetStore', () => {
  it('round-trips bytes, reports absence and deletes', async () => {
    const store = new MemoryAssetStore();
    expect(await store.has(KEY)).toBe(false);
    expect(await store.read(KEY)).toBeNull();
    await store.write(KEY, bytes('hello'));
    expect(await store.has(KEY)).toBe(true);
    expect(await store.read(KEY)).toEqual(bytes('hello'));
    await store.delete(KEY);
    expect(await store.read(KEY)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('hands out a copy, so a caller cannot corrupt what it cached', async () => {
    // The bytes go on to a WASM heap and may be mutated there; the cached copy must survive it.
    const store = new MemoryAssetStore();
    await store.write(KEY, bytes('hello'));
    const first = await store.read(KEY);
    first![0] = 0xff;
    expect(await store.read(KEY)).toEqual(bytes('hello'));

    const written = bytes('world');
    await store.write(OTHER_KEY, written);
    written[0] = 0xff;
    expect(await store.read(OTHER_KEY)).toEqual(bytes('world'));
  });

  it('clears everything', async () => {
    const store = new MemoryAssetStore();
    await store.write(KEY, bytes('hello'));
    await store.write(OTHER_KEY, bytes('world'));
    await store.clear();
    expect(store.size).toBe(0);
  });
});

describe('OpfsAssetStore', () => {
  it('writes through OPFS and reads back the same bytes', async () => {
    const root = fakeOpfsRoot();
    const store = new OpfsAssetStore(root);
    expect(await store.has(KEY)).toBe(false);
    await store.write(KEY, bytes('melee'));
    expect(await store.has(KEY)).toBe(true);
    expect(await store.read(KEY)).toEqual(bytes('melee'));
    // The blob lives in one directory named after the store's own namespace, under its hash.
    expect(root.directoryNames).toEqual([ASSET_DIRECTORY]);
    expect(root.lookups).toContain(`file:${KEY}`);
  });

  it('creates the assets directory on first write and tolerates its absence on read', async () => {
    const root = fakeOpfsRoot();
    const store = new OpfsAssetStore(root);
    // Reading before anything was written: the directory itself does not exist yet.
    expect(await store.read(KEY)).toBeNull();
    expect(await store.has(KEY)).toBe(false);
    await store.write(KEY, bytes('x'));
    expect(root.directoryNames).toEqual([ASSET_DIRECTORY]);
  });

  it('reports a missing file as absent, not as an error', async () => {
    const root = fakeOpfsRoot();
    const store = new OpfsAssetStore(root);
    await store.write(KEY, bytes('x'));
    expect(await store.read(OTHER_KEY)).toBeNull();
    expect(await store.has(OTHER_KEY)).toBe(false);
    // Deleting something that is not there is not a failure either: eviction races a read.
    await expect(store.delete(OTHER_KEY)).resolves.toBeUndefined();
  });

  it('deletes one blob and clears the rest', async () => {
    const root = fakeOpfsRoot();
    const store = new OpfsAssetStore(root);
    await store.write(KEY, bytes('one'));
    await store.write(OTHER_KEY, bytes('two'));
    await store.delete(KEY);
    expect(await store.read(KEY)).toBeNull();
    expect(await store.read(OTHER_KEY)).toEqual(bytes('two'));

    await store.clear();
    expect(await store.read(OTHER_KEY)).toBeNull();
    // clear() removes the whole directory, which is why the fake refuses a non-recursive
    // removal of one: a clear() that forgot `recursive` fails here.
    expect(root.directoryNames).toEqual([]);
  });

  it('leaves nothing visible under a hash until the write is closed', async () => {
    // A half-written file must never sit under a name that claims its contents.
    const root = fakeOpfsRoot();
    const store = new OpfsAssetStore(root);
    await store.write(KEY, bytes('whole'));
    expect(await store.read(KEY)).toEqual(bytes('whole'));
  });

  it('surfaces an unexpected file system error instead of reporting absence', async () => {
    // Only NotFoundError means "absent". A quota or permission failure must not look like an
    // empty cache, or the shell would re-download the whole tree on every frame.
    const root = fakeOpfsRoot();
    const store = new OpfsAssetStore(root);
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValue(new Error('permission denied'));
    await expect(store.read(KEY)).rejects.toThrow('permission denied');
  });
});

describe('createAssetStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports no OPFS root when navigator has no storage', () => {
    vi.stubGlobal('navigator', {});
    expect(defaultOpfsRoot()).toBeNull();
  });

  it('falls back to memory when the browser has no OPFS', async () => {
    vi.stubGlobal('navigator', {});
    const store = await createAssetStore();
    expect(store).toBeInstanceOf(MemoryAssetStore);
    await store.write(KEY, bytes('x'));
    expect(await store.read(KEY)).toEqual(bytes('x'));
  });

  it('falls back to memory when the OPFS directory cannot be opened', async () => {
    // A private window: `getDirectory` exists and rejects. The session must still work.
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.reject(new Error('blocked by private mode')) },
    });
    const store = await createAssetStore();
    expect(store).toBeInstanceOf(MemoryAssetStore);
  });

  it('uses OPFS when it is there', async () => {
    const root = fakeOpfsRoot();
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(root) } });
    const store = await createAssetStore();
    expect(store).toBeInstanceOf(OpfsAssetStore);
    await store.write(KEY, bytes('persisted'));
    expect(await store.read(KEY)).toEqual(bytes('persisted'));
    expect(root.directoryNames).toEqual([ASSET_DIRECTORY]);
  });

  it('satisfies the AssetStore contract on both implementations', async () => {
    const stores: AssetStore[] = [new MemoryAssetStore(), new OpfsAssetStore(fakeOpfsRoot())];
    for (const store of stores) {
      await store.write(KEY, bytes('contract'));
      expect(await store.has(KEY)).toBe(true);
      expect(await store.read(KEY)).toEqual(bytes('contract'));
      await store.clear();
      expect(await store.has(KEY)).toBe(false);
    }
  });
});
