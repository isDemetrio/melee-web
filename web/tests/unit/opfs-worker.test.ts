/**
 * The OPFS worker: the rules of the disc cache's storage, asserted without a browser.
 *
 * The file system under it is the fake in `fakes/fakeSyncOpfs.ts`, which keeps the platform's own
 * rules rather than a convenient version of them. What is asserted here, and why:
 *
 *  - a cache that was never written is zero bytes and creates nothing;
 *  - every append lands at the end, is flushed before the caller is told, and closes its handle,
 *    and only one handle is ever open at once, even with three operations asked for at once;
 *  - a write that does not land at the end, a file system that wrote fewer bytes than the piece,
 *    and a cut that would *grow* the file are all refused, because each of them is a way to put
 *    the wrong bytes in a disc image without any error to show for it;
 *  - the `File` comes back with the name the core mounts, and is produced with no handle open;
 *  - every operation takes the cache's lock, exclusively, and the operations still run where the
 *    browser has no Web Locks at all;
 *  - an identity that is not the SHA-256 of a manifest is refused before it becomes a path;
 *  - every message gets an answer carrying the id it came with, including one that could not be
 *    read at all -- a page waiting for a reply that never comes cannot tell that from a slow disk.
 */

import { describe, expect, it } from 'vitest';
import type { DiscStore } from '../../src/spike/disc-cache.js';
import {
  DISC_DIRECTORY,
  DISC_FILE_NAME,
  OpfsDiscStore,
  OpfsDiscStoreError,
  answerDiscStoreRequest,
  discLockName,
  isNotFound,
  parseDiscStoreRequest,
  registerDiscStoreWorker,
  storeRequestId,
  type DiscStoreReply,
  type WorkerScopeLike,
} from '../../src/spike/opfs-worker.js';
import {
  fakeLocks,
  fakeSyncOpfsRoot,
  notFound,
  withoutSyncAccessHandle,
  type FakeSyncDirectory,
  type FakeSyncFileHandle,
} from './fakes/fakeSyncOpfs.js';

/** A cache identity: the lowercase hex SHA-256 of a manifest. */
const IDENTITY = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** A deterministic piece of `length` bytes, so a failure is reproducible. */
function piece(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index++) out[index] = (seed * 31 + index) % 251;
  return out;
}

interface Setup {
  readonly root: FakeSyncDirectory;
  readonly locks: ReturnType<typeof fakeLocks>;
  readonly store: OpfsDiscStore;
  readonly disc: DiscStore;
  /** The cached file, or null when nothing has created it. */
  file(): FakeSyncFileHandle | null;
}

function setup(withLocks = false): Setup {
  const root = fakeSyncOpfsRoot();
  const locks = fakeLocks();
  const store = new OpfsDiscStore({
    root: async () => root,
    locks: withLocks ? locks.request : null,
  });
  const file = (): FakeSyncFileHandle | null =>
    root.directory(DISC_DIRECTORY)?.directory(IDENTITY)?.file(DISC_FILE_NAME) ?? null;
  return { root, locks, store, disc: store.forIdentity(IDENTITY), file };
}

function requireFile(current: Setup): FakeSyncFileHandle {
  const file = current.file();
  if (!file) throw new Error('the operation created no cached file');
  return file;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10_000 && !predicate(); attempt++) await Promise.resolve();
  if (!predicate()) throw new Error('the awaited condition never became true');
}

function fakeScope(): WorkerScopeLike & { readonly posted: DiscStoreReply[]; send(message: unknown): void } {
  const listeners: ((event: { data: unknown }) => void)[] = [];
  const posted: DiscStoreReply[] = [];
  return {
    posted,
    postMessage: (reply: DiscStoreReply): void => {
      posted.push(reply);
    },
    addEventListener: (_type: 'message', listener: (event: { data: unknown }) => void): void => {
      listeners.push(listener);
    },
    send: (message: unknown): void => {
      for (const listener of listeners) listener({ data: message });
    },
  };
}

describe('OpfsDiscStore', () => {
  it('reports a cache that was never written as zero bytes, and creates nothing', async () => {
    const current = setup();
    expect(await current.disc.length()).toBe(0);
    expect(current.root.directoryNames).toEqual([]);
    expect(current.root.fileNames).toEqual([]);
  });

  it('appends at the end, flushes every piece, and closes the handle', async () => {
    const current = setup();
    await current.disc.append(0, piece(8, 1));
    await current.disc.append(8, piece(4, 2));
    const file = requireFile(current);
    expect(file.bytes.length).toBe(12);
    expect(file.handles).toHaveLength(2);
    // One flush per piece, and the size at each flush is the piece that had just been written.
    expect(file.handles.map((handle) => handle.flushes)).toEqual([[8], [12]]);
    expect(file.handles.map((handle) => handle.writeOffsets)).toEqual([[0], [8]]);
    expect(file.handles.every((handle) => handle.isClosed)).toBe(true);
    expect(file.maxOpen).toBe(1);
    expect(await current.disc.length()).toBe(12);
  });

  it('keeps one handle open at a time when three operations are asked for at once', async () => {
    const current = setup();
    await Promise.all([
      current.disc.append(0, piece(4, 1)),
      current.disc.append(4, piece(4, 2)),
      current.disc.append(8, piece(4, 3)),
    ]);
    expect(requireFile(current).maxOpen).toBe(1);
    expect(await current.disc.length()).toBe(12);
  });

  it('refuses a write that does not land at the end of the file', async () => {
    const current = setup();
    await current.disc.append(0, piece(8, 1));
    await expect(current.disc.append(0, piece(4, 2))).rejects.toThrow(
      /refusing to write 4 bytes at 0: the cached disc is 8 bytes/,
    );
    expect(await current.disc.length()).toBe(8);
    expect(requireFile(current).bytes.length).toBe(8);
    // A refused operation does not poison the queue: the next piece still lands.
    await current.disc.append(8, piece(4, 3));
    expect(await current.disc.length()).toBe(12);
  });

  it('refuses a file system that wrote fewer bytes than the piece', async () => {
    const current = setup();
    await current.disc.append(0, piece(8, 1));
    requireFile(current).shortWrite = true;
    await expect(current.disc.append(8, piece(4, 2))).rejects.toThrow(/wrote 2 of the 4 bytes at 8/);
  });

  it('cuts the file back to a verified prefix, and refuses to grow it', async () => {
    const current = setup();
    await current.disc.append(0, piece(12, 1));
    await current.disc.truncate(8);
    expect(await current.disc.length()).toBe(8);
    const file = requireFile(current);
    expect(file.bytes.length).toBe(8);
    expect(file.handles[1]?.cuts).toEqual([8]);
    await expect(current.disc.truncate(12)).rejects.toThrow(
      /refusing to cut the cached disc to 12: it is 8 bytes/,
    );
    expect(await current.disc.length()).toBe(8);
  });

  it('cuts nothing when there is no cache at all', async () => {
    const current = setup();
    await expect(current.disc.truncate(0)).resolves.toBeUndefined();
    expect(current.root.directoryNames).toEqual([]);
  });

  it('reads the bytes at the offset, and returns a short read at the end as it is', async () => {
    const current = setup();
    await current.disc.append(0, bytes(1, 2, 3, 4, 5, 6, 7, 8));
    expect(Array.from(await current.disc.read(2, 3))).toEqual([3, 4, 5]);
    expect(Array.from(await current.disc.read(6, 4))).toEqual([7, 8]);
    const handles = requireFile(current).handles;
    expect(handles[1]?.readOffsets).toEqual([2]);
    expect(handles[2]?.readOffsets).toEqual([6]);
  });

  it('refuses to read a cache that is not there', async () => {
    const current = setup();
    await expect(current.disc.read(0, 4)).rejects.toThrow(
      /is not there, so 4 bytes at 0 cannot be read/,
    );
  });

  it('returns the File with the name the core mounts, and only with no handle open', async () => {
    const current = setup();
    await current.disc.append(0, bytes(1, 2, 3, 4));
    const file = requireFile(current);
    const disc = await current.disc.file();
    expect(disc.name).toBe(DISC_FILE_NAME);
    expect(Array.from(new Uint8Array(await disc.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    expect(file.fileReadWhileOpen).toBe(false);
    expect(file.getFileCalls).toBe(1);
  });

  it('refuses to hand out a File for a cache that is not there', async () => {
    const current = setup();
    await expect(current.disc.file()).rejects.toThrow(/is not there/);
  });

  it('removes a cache, and removing one that was never written is not a failure', async () => {
    const current = setup();
    await expect(current.disc.remove()).resolves.toBeUndefined();
    await current.disc.append(0, piece(4, 1));
    await current.disc.remove();
    expect(await current.disc.length()).toBe(0);
    expect(current.root.directory(DISC_DIRECTORY)?.directoryNames).toEqual([]);
  });

  it('removes only the identity it was asked about', async () => {
    const current = setup();
    const one = current.store.forIdentity(IDENTITY);
    const other = current.store.forIdentity(OTHER);
    await one.append(0, piece(4, 1));
    await other.append(0, piece(4, 9));
    await one.remove();
    expect(await one.length()).toBe(0);
    expect(await other.length()).toBe(4);
  });

  it('refuses an identity that is not a manifest hash, before it becomes a path', async () => {
    const current = setup();
    for (const identity of ['../../assets', 'A'.repeat(64), 'a'.repeat(63), '']) {
      await expect(current.store.forIdentity(identity).length()).rejects.toThrow(OpfsDiscStoreError);
    }
    expect(current.root.lookups).toEqual([]);
  });

  it('passes a refusal of the origin directory through rather than reporting an empty cache', async () => {
    const store = new OpfsDiscStore({
      root: () => Promise.reject(new Error('the origin private file system is refused')),
      locks: null,
    });
    await expect(store.forIdentity(IDENTITY).length()).rejects.toThrow(/is refused/);
  });

  it('says so when the browser has no synchronous access handle', async () => {
    const current = setup();
    await current.disc.append(0, piece(4, 1));
    withoutSyncAccessHandle(requireFile(current));
    await expect(current.disc.length()).rejects.toThrow(/no createSyncAccessHandle\(\)/);
  });

  it('takes the cache lock, exclusively, once per operation', async () => {
    const current = setup(true);
    await current.disc.append(0, piece(4, 1));
    await current.disc.read(0, 4);
    await current.disc.length();
    await current.disc.file();
    await current.disc.truncate(2);
    await current.disc.remove();
    expect(current.locks.names).toHaveLength(6);
    expect(new Set(current.locks.names)).toEqual(new Set([discLockName(IDENTITY)]));
    expect(current.locks.maxConcurrent()).toBe(1);
  });

  it('runs without Web Locks when the browser has none', async () => {
    const current = setup(false);
    await current.disc.append(0, piece(4, 1));
    expect(await current.disc.length()).toBe(4);
    expect(current.locks.names).toEqual([]);
  });

  it('tells the platform\'s own not-found apart from a real failure', () => {
    expect(isNotFound(notFound())).toBe(true);
    expect(isNotFound(new Error('the disk is on fire'))).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});

describe('the worker protocol', () => {
  it('answers with the id of the request it is answering', async () => {
    const { store } = setup();
    expect(await answerDiscStoreRequest(store, { id: 7, op: 'length', identity: IDENTITY })).toEqual({
      id: 7,
      ok: true,
      value: 0,
    });
  });

  it('answers a message it cannot read at all, with id 0', async () => {
    const { store } = setup();
    for (const message of [{ op: 'length' }, null, 'length', 42]) {
      const reply = await answerDiscStoreRequest(store, message);
      expect(reply.id).toBe(0);
      expect(reply.ok).toBe(false);
    }
    expect(storeRequestId({ op: 'length' })).toBe(0);
    expect(storeRequestId({ id: 3.5 })).toBe(0);
    expect(storeRequestId({ id: 0 })).toBe(0);
    expect(storeRequestId({ id: 4 })).toBe(4);
  });

  it('refuses an operation it does not know, with the id it came with', async () => {
    const { store } = setup();
    expect(await answerDiscStoreRequest(store, { id: 3, op: 'launch', identity: IDENTITY })).toEqual({
      id: 3,
      ok: false,
      error: { name: 'OpfsDiscStoreError', message: 'unknown operation launch' },
    });
  });

  it('refuses fields that are not the shapes they claim', async () => {
    const { store } = setup();
    const bad: unknown[] = [
      { id: 1, op: 'read', identity: IDENTITY },
      { id: 1, op: 'read', identity: IDENTITY, offset: -1, length: 4 },
      { id: 1, op: 'read', identity: IDENTITY, offset: 0, length: 1.5 },
      { id: 1, op: 'append', identity: IDENTITY, offset: 0, bytes: 'four bytes' },
      { id: 1, op: 'truncate', identity: IDENTITY, size: 1.5 },
      { id: 1, op: 'length' },
      { id: 1, op: 'length', identity: 42 },
    ];
    for (const message of bad) {
      const reply = await answerDiscStoreRequest(store, message);
      expect(reply.ok).toBe(false);
      expect(reply.id).toBe(1);
    }
    expect(await answerDiscStoreRequest(store, { id: 1, op: 'read', identity: IDENTITY })).toEqual({
      id: 1,
      ok: false,
      error: { name: 'OpfsDiscStoreError', message: 'offset must be a non-negative safe integer' },
    });
  });

  it('keeps the request it was given, field by field', () => {
    expect(
      parseDiscStoreRequest({ id: 5, op: 'append', identity: IDENTITY, offset: 8, bytes: bytes(1, 2) }, 5),
    ).toEqual({ id: 5, op: 'append', identity: IDENTITY, offset: 8, bytes: bytes(1, 2) });
  });

  it('registers on a worker scope and answers every message', async () => {
    const { store } = setup();
    const scope = fakeScope();
    registerDiscStoreWorker(scope, store);
    scope.send({ id: 11, op: 'length', identity: IDENTITY });
    scope.send({ op: 'length' });
    await until(() => scope.posted.length === 2);
    const byId = new Map(scope.posted.map((reply): [number, DiscStoreReply] => [reply.id, reply]));
    expect(byId.get(11)).toEqual({ id: 11, ok: true, value: 0 });
    expect(byId.get(0)?.ok).toBe(false);
  });
});
