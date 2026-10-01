/**
 * The disc cache's writer: one dedicated OPFS worker.
 *
 * `disc-cache.ts` decides *what* a verified disc is. This file decides *where* the bytes go.
 * OPFS is the only storage in a browser that can hold 1.36 GiB and still be there after a
 * reload, and the part of OPFS that writes synchronously -- `createSyncAccessHandle()` -- exists
 * **only inside a worker**. So the writing lives here, in a worker of its own, and the page keeps
 * nothing but the message plumbing (`web/src/spike/opfs-store.ts`).
 *
 * The rules this file implements, and why none of them is decoration:
 *
 *  1. **At most one sync access handle exists at any moment.** OPFS grants one writer per file:
 *     while a sync access handle is open, a second `createSyncAccessHandle()` on the same file
 *     fails. Every operation is queued behind the previous one and the handle is closed in a
 *     `finally`, so an operation that throws cannot leave the file locked for the rest of the
 *     session.
 *  2. **A piece is flushed before the caller is told it is stored.** `flush()` is what makes the
 *     bytes survive a tab that is closed mid-download. Without it the resume scan would re-read a
 *     hole that the file system had not written yet.
 *  3. **A write lands only at the current end of the file.** An append at any other offset is
 *     refused, with both numbers in the message. A write into the middle of a cached disc is
 *     silent corruption, and it is the kind that shows up later as a trace that differs.
 *  4. **A cut may only shrink the file.** The platform's truncate() *extends* a file with zeros when
 *     asked for a larger size, and zeros in the middle of a disc image are a different game
 *     rather than a shorter one.
 *  5. **The `File` is produced after the close, never during.** `getFile()` is a snapshot;
 *     handing one out while a writer still holds the file would describe bytes that are moving.
 *     The queue is what makes "no handle is open here" true rather than hopeful.
 *  6. **Operations are serialised across tabs as well**, with the Web Locks API under one name per
 *     cache identity. Two tabs share one OPFS file, and this worker's queue says nothing about the
 *     other tab's worker. The same name is what the page takes to serialise a download, a deletion
 *     and a run against each other.
 *  7. **One cache per identity, in its own directory.** The directory is named by the SHA-256 of
 *     the manifest (`disc-cache.ts`), and the shape of that name is checked here before it becomes
 *     a path -- it is the only string from outside this file that ends up in a file name.
 *
 * OPFS and the lock manager are described structurally and injected, so the rules above are
 * asserted in `web/tests/unit/opfs-worker.test.ts` against a fake file system that keeps the
 * platform's own rules (a handle that is closed refuses further use, a name that does not exist
 * raises `NotFoundError`, `{ create: true }` is required to create one), without a browser.
 */

import type { DiscStore } from './disc-cache.js';

/** The directory inside the origin private file system that holds the cached disc. */
export const DISC_DIRECTORY = 'phase0-disc';

/**
 * The cached file's name.
 *
 * The core mounts the disc by name -- `worker.ts` passes `--iso /disc/<name>` -- so this is not a
 * free choice: it is the name the simulation reads. It is deliberately not the operator's own
 * file name, which never reaches this side of the page.
 */
export const DISC_FILE_NAME = 'melee-ntsc102.iso';

/** The shape of a cache identity: the lowercase hex SHA-256 of the manifest. */
export const IDENTITY_PATTERN = /^[0-9a-f]{64}$/;

/** The Web Lock one cache identity is guarded by, in every tab of the origin. */
export function discLockName(identity: string): string {
  return `melee-disc-cache:${identity}`;
}

/** One synchronous access handle, as much of `FileSystemSyncAccessHandle` as this worker uses. */
export interface SyncAccessHandleLike {
  /** Bytes currently in the file. */
  getSize(): number;
  /** Bytes read, which may be fewer than the buffer asked for. */
  read(buffer: Uint8Array, options?: { at?: number }): number;
  /** Bytes written, which must be the whole buffer. */
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  /** Push what has been written to the disk, so a closed tab does not lose it. */
  flush(): void;
  close(): void;
}

/** One file handle, as much of `FileSystemFileHandle` as this worker uses. */
export interface SyncFileHandleLike {
  getFile(): Promise<File>;
  createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
}

/** One directory handle, as much of `FileSystemDirectoryHandle` as this worker uses. */
export interface SyncDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SyncFileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SyncDirectoryLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The one Web Lock call this worker makes, so a test can watch the names it takes. */
export type LockRequest = <T>(
  name: string,
  options: { mode: 'exclusive' },
  callback: () => Promise<T>,
) => Promise<T>;

export interface OpfsWorkerDeps {
  /** `navigator.storage.getDirectory()`, called per operation: it can reject on its own. */
  readonly root: () => Promise<SyncDirectoryLike>;
  /** `navigator.locks.request`, or null where the browser has no Web Locks. */
  readonly locks: LockRequest | null;
}

/** A refusal this worker makes, as opposed to one the platform makes. */
export class OpfsDiscStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpfsDiscStoreError';
  }
}

/** `true` for the exception OPFS raises for an absent name. */
export function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'NotFoundError';
}

function assertIdentity(identity: string): void {
  if (!IDENTITY_PATTERN.test(identity)) {
    throw new OpfsDiscStoreError(
      `refusing a cache identity that is not the lowercase hex SHA-256 of a manifest: ${identity}`,
    );
  }
}

/** Nothing to do with the result, and nothing to do with the failure: it keeps the queue alive. */
const ignore = (): void => undefined;

/**
 * The caches of one worker, as the `DiscStore` the download module expects.
 *
 * Every identity shares one instance, because they share one worker and therefore one writer: the
 * queue and the lock belong to the worker, not to the cache.
 */
export class OpfsDiscStore {
  /** The queue: the promise of the last operation, whatever it did. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OpfsWorkerDeps) {}

  /** A `DiscStore` for one cache identity. */
  forIdentity(identity: string): DiscStore {
    return new BoundDiscStore(this, identity);
  }

  /** Bytes stored for this cache, `0` when there is no file yet. */
  length(identity: string): Promise<number> {
    return this.run(identity, async () => {
      const directory = await this.openDirectory(identity, false);
      if (!directory) return 0;
      const file = await this.openFile(directory, false);
      if (!file) return 0;
      const handle = await this.syncHandle(file);
      try {
        return handle.getSize();
      } finally {
        handle.close();
      }
    });
  }

  /** The `length` bytes at `offset`, or as many of them as the file holds. */
  read(identity: string, offset: number, length: number): Promise<Uint8Array> {
    return this.run(identity, async () => {
      const directory = await this.openDirectory(identity, false);
      const file = directory ? await this.openFile(directory, false) : null;
      if (!file) {
        throw new OpfsDiscStoreError(
          `the cached disc ${identity} is not there, so ${length} bytes at ${offset} cannot be read`,
        );
      }
      const handle = await this.syncHandle(file);
      try {
        const bytes = new Uint8Array(length);
        const read = handle.read(bytes, { at: offset });
        // A short read is handed back as it is rather than padded: `disc-cache.ts` compares the
        // length with what the manifest promises and cuts the file at the first piece that does
        // not measure up.
        return read === length ? bytes : bytes.subarray(0, read);
      } finally {
        handle.close();
      }
    });
  }

  /** Append verified bytes at `offset`, which must be the current end of the file. */
  append(identity: string, offset: number, bytes: Uint8Array): Promise<void> {
    return this.run(identity, async () => {
      const directory = await this.writeDirectory(identity);
      const file = await directory.getFileHandle(DISC_FILE_NAME, { create: true });
      const handle = await this.syncHandle(file);
      try {
        const size = handle.getSize();
        if (size !== offset) {
          throw new OpfsDiscStoreError(
            `refusing to write ${bytes.length} bytes at ${offset}: the cached disc is ${size} bytes, and an append may only land at its end`,
          );
        }
        const written = handle.write(bytes, { at: offset });
        if (written !== bytes.length) {
          throw new OpfsDiscStoreError(
            `the file system wrote ${written} of the ${bytes.length} bytes at ${offset}`,
          );
        }
        // Rule 2: flushed before this promise resolves, so the caller's next piece cannot land on
        // top of bytes that are still only in the page cache.
        handle.flush();
      } finally {
        handle.close();
      }
    });
  }

  /** Cut the file to `size`, which may only be smaller than what is there. */
  truncate(identity: string, size: number): Promise<void> {
    return this.run(identity, async () => {
      const directory = await this.openDirectory(identity, false);
      if (!directory) return;
      const file = await this.openFile(directory, false);
      if (!file) return;
      const handle = await this.syncHandle(file);
      try {
        const current = handle.getSize();
        if (size > current) {
          throw new OpfsDiscStoreError(
            `refusing to cut the cached disc to ${size}: it is ${current} bytes, and the platform's truncate() would fill the difference with zeros`,
          );
        }
        if (size === current) return;
        handle.truncate(size);
        handle.flush();
      } finally {
        handle.close();
      }
    });
  }

  /** The disc as a `File`, which is what the core is mounted with. */
  file(identity: string): Promise<File> {
    return this.run(identity, async () => {
      const directory = await this.openDirectory(identity, false);
      const file = directory ? await this.openFile(directory, false) : null;
      if (!file) throw new OpfsDiscStoreError(`the cached disc ${identity} is not there`);
      // Rule 5: no sync access handle is open here -- `run()` serialises the operations and every
      // one of them closes its handle in a `finally` -- so this File cannot describe bytes that a
      // writer is still moving.
      return file.getFile();
    });
  }

  /** Delete this cache. A cache that is not there is not a failure. */
  remove(identity: string): Promise<void> {
    return this.run(identity, async () => {
      const root = await this.deps.root();
      try {
        const parent = await root.getDirectoryHandle(DISC_DIRECTORY, { create: false });
        await parent.removeEntry(identity, { recursive: true });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    });
  }

  /**
   * Queue one operation, and take the cache's lock around it.
   *
   * Rules 1 and 6: one operation at a time inside this worker, one writer at a time across tabs.
   * The queue's own promise never rejects, so one failed operation does not poison the next.
   */
  private run<T>(identity: string, body: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => this.withLock(identity, body));
    this.tail = next.then(ignore, ignore);
    return next;
  }

  private withLock<T>(identity: string, body: () => Promise<T>): Promise<T> {
    const locks = this.deps.locks;
    // Without Web Locks the operation still runs: a browser that cannot lock is worse served by a
    // refusal than by the download it asked for, and rule 3 still refuses a wrong-offset write.
    if (!locks) return body();
    return locks(discLockName(identity), { mode: 'exclusive' }, body);
  }

  /** The cache's directory, or null when it does not exist and `create` is false. */
  private async openDirectory(identity: string, create: boolean): Promise<SyncDirectoryLike | null> {
    assertIdentity(identity);
    const root = await this.deps.root();
    try {
      const parent = await root.getDirectoryHandle(DISC_DIRECTORY, { create });
      return await parent.getDirectoryHandle(identity, { create });
    } catch (error) {
      if (!create && isNotFound(error)) return null;
      throw error;
    }
  }

  /** The cache's directory, created if it is missing. */
  private async writeDirectory(identity: string): Promise<SyncDirectoryLike> {
    assertIdentity(identity);
    const root = await this.deps.root();
    const parent = await root.getDirectoryHandle(DISC_DIRECTORY, { create: true });
    return parent.getDirectoryHandle(identity, { create: true });
  }

  private async openFile(
    directory: SyncDirectoryLike,
    create: boolean,
  ): Promise<SyncFileHandleLike | null> {
    try {
      return await directory.getFileHandle(DISC_FILE_NAME, { create });
    } catch (error) {
      if (!create && isNotFound(error)) return null;
      throw error;
    }
  }

  private async syncHandle(file: SyncFileHandleLike): Promise<SyncAccessHandleLike> {
    if (typeof file.createSyncAccessHandle !== 'function') {
      throw new OpfsDiscStoreError(
        'this browser has no createSyncAccessHandle(), so the disc cannot be written into OPFS',
      );
    }
    return file.createSyncAccessHandle();
  }
}

/** One identity's view of the worker's store: the shape `disc-cache.ts` asks for. */
class BoundDiscStore implements DiscStore {
  constructor(
    private readonly store: OpfsDiscStore,
    private readonly identity: string,
  ) {}

  length(): Promise<number> {
    return this.store.length(this.identity);
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    return this.store.read(this.identity, offset, length);
  }

  append(offset: number, bytes: Uint8Array): Promise<void> {
    return this.store.append(this.identity, offset, bytes);
  }

  truncate(size: number): Promise<void> {
    return this.store.truncate(this.identity, size);
  }

  file(): Promise<File> {
    return this.store.file(this.identity);
  }

  remove(): Promise<void> {
    return this.store.remove(this.identity);
  }
}

/** The operations the page can ask for, one message each. */
export type DiscStoreOp = 'length' | 'read' | 'append' | 'truncate' | 'file' | 'remove';

/**
 * One identified request.
 *
 * `id` is what makes a reply match its request: the page can have a resume scan and a download in
 * the air at once, and a reply without an id could not be told from the other one's.
 */
export interface DiscStoreRequest {
  readonly id: number;
  readonly op: DiscStoreOp;
  readonly identity: string;
  /** `read`, `append`: where in the cached disc the bytes start. */
  readonly offset?: number;
  /** `read`: how many bytes to return. */
  readonly length?: number;
  /** `append`: the verified piece. */
  readonly bytes?: Uint8Array;
  /** `truncate`: the size the file is cut to. */
  readonly size?: number;
}

export interface DiscStoreValueReply {
  readonly id: number;
  readonly ok: true;
  /** The answer: a number, bytes, a `File`, or nothing at all for the operations that only act. */
  readonly value?: number | Uint8Array | File;
}

export interface DiscStoreErrorReply {
  readonly id: number;
  readonly ok: false;
  readonly error: { readonly name: string; readonly message: string };
}

export type DiscStoreReply = DiscStoreValueReply | DiscStoreErrorReply;

/** The id of a message, or `0` when it has none: `0` is never a request the page sends. */
export function storeRequestId(message: unknown): number {
  const id = (message as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

function requireCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OpfsDiscStoreError(`${what} must be a non-negative safe integer`);
  }
  return value;
}

function requireBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new OpfsDiscStoreError('bytes must be a Uint8Array');
  }
  return value;
}

function isOp(value: unknown): value is DiscStoreOp {
  return (
    value === 'length' ||
    value === 'read' ||
    value === 'append' ||
    value === 'truncate' ||
    value === 'file' ||
    value === 'remove'
  );
}

/** Validate one request. A message that does not describe an operation is refused here. */
export function parseDiscStoreRequest(message: unknown, id: number): DiscStoreRequest {
  if (typeof message !== 'object' || message === null) {
    throw new OpfsDiscStoreError('a request must be an object');
  }
  const fields = message as Record<string, unknown>;
  const op = fields.op;
  if (!isOp(op)) throw new OpfsDiscStoreError(`unknown operation ${String(op)}`);
  const identity = fields.identity;
  if (typeof identity !== 'string') {
    throw new OpfsDiscStoreError('identity must be the lowercase hex SHA-256 of the manifest');
  }
  const base = { id, op, identity };
  switch (op) {
    case 'length':
    case 'file':
    case 'remove':
      return base;
    case 'read':
      return {
        ...base,
        offset: requireCount(fields.offset, 'offset'),
        length: requireCount(fields.length, 'length'),
      };
    case 'append':
      return {
        ...base,
        offset: requireCount(fields.offset, 'offset'),
        bytes: requireBytes(fields.bytes),
      };
    case 'truncate':
      return { ...base, size: requireCount(fields.size, 'size') };
    default:
      throw new OpfsDiscStoreError(`unknown operation ${String(op)}`);
  }
}

/**
 * Answer one message. Every message gets an answer, including one that could not be understood: a
 * page waiting for a reply that never comes has no way to tell that from a slow disk.
 */
export async function answerDiscStoreRequest(
  store: OpfsDiscStore,
  message: unknown,
): Promise<DiscStoreReply> {
  const id = storeRequestId(message);
  try {
    const request = parseDiscStoreRequest(message, id);
    const disc = store.forIdentity(request.identity);
    switch (request.op) {
      case 'length':
        return { id, ok: true, value: await disc.length() };
      case 'read':
        return {
          id,
          ok: true,
          value: await disc.read(requireCount(request.offset, 'offset'), requireCount(request.length, 'length')),
        };
      case 'append':
        await disc.append(requireCount(request.offset, 'offset'), requireBytes(request.bytes));
        return { id, ok: true };
      case 'truncate':
        await disc.truncate(requireCount(request.size, 'size'));
        return { id, ok: true };
      case 'file':
        return { id, ok: true, value: await disc.file() };
      case 'remove':
        await disc.remove();
        return { id, ok: true };
      default:
        throw new OpfsDiscStoreError(`unknown operation ${String(request.op)}`);
    }
  } catch (error) {
    return { id, ok: false, error: describe(error) };
  }
}

/** The worker scope, as much of `DedicatedWorkerGlobalScope` as this file uses. */
export interface WorkerScopeLike {
  postMessage(message: DiscStoreReply): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** Wire a store to a worker scope: one answer per message, and never a silent one. */
export function registerDiscStoreWorker(scope: WorkerScopeLike, store: OpfsDiscStore): void {
  scope.addEventListener('message', (event) => {
    void answerDiscStoreRequest(store, event.data).then((reply) => scope.postMessage(reply));
  });
}

/** The scope, or null when this module was not loaded in a worker. */
function workerScope(): WorkerScopeLike | null {
  if (typeof self === 'undefined') return null;
  const scope = self as unknown as Partial<WorkerScopeLike> & { document?: unknown };
  if (typeof scope.postMessage !== 'function' || typeof scope.addEventListener !== 'function') {
    return null;
  }
  // A window has both as well, and is not where a sync access handle may be opened: if this module
  // is ever imported by a page by mistake, it registers nothing rather than failing on `self`.
  if ('document' in scope) return null;
  return scope as WorkerScopeLike;
}

/** `navigator.storage.getDirectory`, or a root that refuses with a message worth reading. */
export function platformRoot(): () => Promise<SyncDirectoryLike> {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const storage = nav && 'storage' in nav
    ? (nav.storage as unknown as { getDirectory?: () => Promise<unknown> } | undefined)
    : undefined;
  if (!storage?.getDirectory) {
    return () =>
      Promise.reject(
        new OpfsDiscStoreError(
          'this browser has no navigator.storage.getDirectory(), so it has no origin private file system to cache the disc in',
        ),
      );
  }
  const getDirectory = storage.getDirectory.bind(storage);
  return () => getDirectory() as Promise<SyncDirectoryLike>;
}

/** `navigator.locks.request`, or null where the browser has no Web Locks. */
export function platformLocks(): LockRequest | null {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const locks = nav && 'locks' in nav
    ? (nav.locks as unknown as { request?: unknown } | undefined)
    : undefined;
  const request = locks?.request;
  if (typeof request !== 'function') return null;
  return request.bind(locks) as LockRequest;
}

const scope = workerScope();
if (scope) {
  registerDiscStoreWorker(scope, new OpfsDiscStore({ root: platformRoot(), locks: platformLocks() }));
}
