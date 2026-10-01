/**
 * A fake Origin Private File System, faithful to the parts the OPFS worker relies on.
 *
 * The unit tests must exercise the worker's real behaviour, not a convenient one, so this fake
 * keeps the platform's own rules:
 *
 *  - a name that does not exist raises `NotFoundError`, and creating one requires
 *    `{ create: true }`;
 *  - `getDirectoryHandle` without `create` fails when the directory is absent, so an
 *    implementation that forgets to create `phase0-disc/` fails here the way it fails in a
 *    browser;
 *  - a sync access handle that has been closed refuses every further call, and the file records
 *    how many handles were open at once -- OPFS grants one writer per file, so a second
 *    `createSyncAccessHandle()` on an open file is not something this worker may do;
 *  - the platform's `truncate()` *extends* a file with zeros when asked for a larger size, which
 *    is exactly the behaviour the worker refuses to rely on;
 *  - `getFile()` records whether it was asked for while a handle was open.
 *
 * It is not a file system: no quota, no locking, no cross-tab visibility. Those are noted where
 * they matter.
 */

import type {
  LockRequest,
  SyncAccessHandleLike,
  SyncDirectoryLike,
  SyncFileHandleLike,
} from '../../../src/spike/opfs-worker.js';

class FakeFsError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** The error OPFS raises for an absent name. */
export function notFound(): Error {
  return new FakeFsError('NotFoundError', 'A requested file or directory could not be found');
}

/** One synchronous access handle over the bytes of one fake file. */
export class FakeSyncAccessHandle implements SyncAccessHandleLike {
  /** Test-only: the file size at every `flush()`, so "flushed after every piece" is checkable. */
  readonly flushes: number[] = [];
  /** Test-only: the offset of every write and every read, in order. */
  readonly writeOffsets: number[] = [];
  readonly readOffsets: number[] = [];
  /** Test-only: the size of every cut. */
  readonly cuts: number[] = [];
  private closed = false;

  constructor(private readonly file: FakeSyncFileHandle) {}

  get isClosed(): boolean {
    return this.closed;
  }

  getSize(): number {
    this.assertOpen();
    return this.file.bytes.length;
  }

  read(buffer: Uint8Array, options?: { at?: number }): number {
    this.assertOpen();
    const at = options?.at ?? 0;
    this.readOffsets.push(at);
    const available = Math.max(0, Math.min(buffer.length, this.file.bytes.length - at));
    buffer.set(this.file.bytes.subarray(at, at + available));
    return available;
  }

  write(buffer: Uint8Array, options?: { at?: number }): number {
    this.assertOpen();
    const at = options?.at ?? 0;
    this.writeOffsets.push(at);
    // A file system that writes less than it was given is a real failure mode, and the worker has
    // to refuse it rather than report a piece as stored.
    const count = this.file.shortWrite ? Math.floor(buffer.length / 2) : buffer.length;
    const end = at + count;
    const next = new Uint8Array(Math.max(this.file.bytes.length, end));
    next.set(this.file.bytes);
    next.set(buffer.subarray(0, count), at);
    this.file.bytes = next;
    return count;
  }

  truncate(size: number): void {
    this.assertOpen();
    this.cuts.push(size);
    // The platform zero-fills when the new size is larger. Kept, because the worker's refusal to
    // grow a file is what the test asserts.
    const next = new Uint8Array(size);
    next.set(this.file.bytes.subarray(0, Math.min(size, this.file.bytes.length)));
    this.file.bytes = next;
  }

  flush(): void {
    this.assertOpen();
    this.flushes.push(this.file.bytes.length);
  }

  close(): void {
    if (this.closed) throw new FakeFsError('InvalidStateError', 'the handle is already closed');
    this.closed = true;
    this.file.openHandles--;
  }

  private assertOpen(): void {
    if (this.closed) throw new FakeFsError('InvalidStateError', 'the handle is closed');
  }
}

/** One fake file, and the record of every handle it handed out. */
export class FakeSyncFileHandle implements SyncFileHandleLike {
  bytes = new Uint8Array(0);
  /** Test-only: every handle this file handed out, in order. */
  readonly handles: FakeSyncAccessHandle[] = [];
  /** Test-only: the most handles that were open at once. OPFS allows one. */
  maxOpen = 0;
  /** Test-only: how many times `getFile()` was called. */
  getFileCalls = 0;
  /** Test-only: whether `getFile()` was called while a handle was open. */
  fileReadWhileOpen = false;
  /** Test-only: make the next write store only half of what it was given. */
  shortWrite = false;
  openHandles = 0;

  constructor(readonly name: string) {}

  async createSyncAccessHandle(): Promise<SyncAccessHandleLike> {
    this.openHandles++;
    this.maxOpen = Math.max(this.maxOpen, this.openHandles);
    const handle = new FakeSyncAccessHandle(this);
    this.handles.push(handle);
    return handle;
  }

  async getFile(): Promise<File> {
    this.getFileCalls++;
    if (this.openHandles > 0) this.fileReadWhileOpen = true;
    return new File([this.bytes.slice()], this.name, { type: 'application/octet-stream' });
  }
}

/** One fake directory. */
export class FakeSyncDirectory implements SyncDirectoryLike {
  private readonly files = new Map<string, FakeSyncFileHandle>();
  private readonly directories = new Map<string, FakeSyncDirectory>();
  /** Test-only: every name asked for, in order, with whether creation was requested. */
  readonly lookups: string[] = [];

  get fileNames(): string[] {
    return [...this.files.keys()].sort();
  }

  get directoryNames(): string[] {
    return [...this.directories.keys()].sort();
  }

  /** Test-only: a file, or null when it is not there. */
  file(name: string): FakeSyncFileHandle | null {
    return this.files.get(name) ?? null;
  }

  /** Test-only: a directory, or null when it is not there. */
  directory(name: string): FakeSyncDirectory | null {
    return this.directories.get(name) ?? null;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<SyncFileHandleLike> {
    this.lookups.push(`${options?.create ? 'create' : 'open'}:file:${name}`);
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFound();
    const handle = new FakeSyncFileHandle(name);
    this.files.set(name, handle);
    return handle;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<SyncDirectoryLike> {
    this.lookups.push(`${options?.create ? 'create' : 'open'}:directory:${name}`);
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFound();
    const directory = new FakeSyncDirectory();
    this.directories.set(name, directory);
    return directory;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    this.lookups.push(`remove:${name}`);
    const directory = this.directories.get(name);
    if (directory) {
      if (!options?.recursive) {
        throw new FakeFsError('InvalidModificationError', 'Cannot remove a non-empty directory');
      }
      this.directories.delete(name);
      return;
    }
    if (!this.files.delete(name)) throw notFound();
  }
}

/** A fresh root directory, as `navigator.storage.getDirectory()` would return. */
export function fakeSyncOpfsRoot(): FakeSyncDirectory {
  return new FakeSyncDirectory();
}

/** Test-only: a file handle of a browser that has no synchronous access handle at all. */
export function withoutSyncAccessHandle(file: FakeSyncFileHandle): void {
  (file as unknown as Record<string, unknown>).createSyncAccessHandle = undefined;
}

/** A fake `navigator.locks`: it records the names taken and the most operations held at once. */
export interface FakeLocks {
  readonly names: string[];
  readonly request: LockRequest;
  /** The most operations that were inside the lock at the same time. */
  maxConcurrent(): number;
}

export function fakeLocks(): FakeLocks {
  const names: string[] = [];
  let held = 0;
  let max = 0;
  const request = async <T>(
    name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T> => {
    names.push(name);
    held++;
    if (held > max) max = held;
    try {
      return await callback();
    } finally {
      held--;
    }
  };
  return { names, request, maxConcurrent: () => max };
}
