/**
 * A fake Origin Private File System, faithful to the parts the asset cache relies on.
 *
 * The unit tests must exercise the store's real behaviour, not a convenient one, so this
 * fake keeps the properties of the platform that the store is written around:
 *
 *  - a name that does not exist raises `NotFoundError`, and creating requires `{ create: true }`;
 *  - `getDirectoryHandle` without `create` fails when the directory is absent, so a store that
 *    forgets to create `assets/` fails here the way it fails in a browser;
 *  - writes are buffered until `close()`, so a half-written file is never visible under a name
 *    that claims its contents;
 *  - `removeEntry` on a directory without `{ recursive: true }` raises
 *    `InvalidModificationError`, which is what makes a `clear()` that forgets `recursive` fail.
 *
 * It is not a file system: no locking, no quota, no partial reads, and `getFile()` returns a
 * `Blob` rather than a `File`. Those differences are noted where they matter.
 */

import type {
  OpfsDirectoryLike,
  OpfsFileHandleLike,
  OpfsWritableLike,
} from '../../../src/assets/store.js';

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

/** The error OPFS raises for a non-recursive removal of a directory. */
export function invalidModification(): Error {
  return new FakeFsError('InvalidModificationError', 'Cannot remove a non-empty directory');
}

class FakeWritable implements OpfsWritableLike {
  private buffered: Uint8Array;
  private closed = false;

  constructor(
    bytes: Uint8Array,
    private readonly commit: (bytes: Uint8Array) => void,
  ) {
    this.buffered = bytes.slice();
  }

  write(data: Uint8Array): void {
    if (this.closed) throw new FakeFsError('InvalidStateError', 'stream is closed');
    this.buffered = data.slice();
  }

  close(): void {
    this.closed = true;
    this.commit(this.buffered);
  }

  /** Test-only: what is visible before `close()`, which is nothing. */
  get pending(): Uint8Array {
    return this.buffered;
  }
}

class FakeFileHandle implements OpfsFileHandleLike {
  private bytes: Uint8Array | null = null;
  /** Test-only: every writable handed out, to observe buffering. */
  readonly writables: FakeWritable[] = [];

  get present(): boolean {
    return this.bytes !== null;
  }

  async getFile(): Promise<Blob> {
    if (this.bytes === null) throw notFound();
    return new Blob([new Uint8Array(this.bytes)]);
  }

  async createWritable(): Promise<OpfsWritableLike> {
    const writable = new FakeWritable(this.bytes ?? new Uint8Array(0), (bytes) => {
      this.bytes = bytes;
    });
    this.writables.push(writable);
    return writable;
  }

  async remove(): Promise<void> {
    this.bytes = null;
  }
}

export class FakeOpfsDirectory implements OpfsDirectoryLike {
  private readonly files = new Map<string, FakeFileHandle>();
  private readonly directories = new Map<string, FakeOpfsDirectory>();
  /**
   * Test-only: every name a handle was asked for, in this tree, in order.
   *
   * Shared with the child directories rather than kept per directory, because what a test
   * wants to observe is how the store reaches for a name -- and the blob it reaches for lives
   * in `assets/`, one level below the root the store was handed.
   */
  readonly lookups: string[];

  constructor(lookups: string[] = []) {
    this.lookups = lookups;
  }

  get fileNames(): string[] {
    return [...this.files.keys()].sort();
  }

  get directoryNames(): string[] {
    return [...this.directories.keys()].sort();
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike> {
    this.lookups.push(`file:${name}`);
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFound();
    const handle = new FakeFileHandle();
    this.files.set(name, handle);
    return handle;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryLike> {
    this.lookups.push(`directory:${name}`);
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFound();
    const directory = new FakeOpfsDirectory(this.lookups);
    this.directories.set(name, directory);
    return directory;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    this.lookups.push(`remove:${name}`);
    const directory = this.directories.get(name);
    if (directory) {
      if (!options?.recursive) throw invalidModification();
      this.directories.delete(name);
      return;
    }
    const file = this.files.get(name);
    if (!file) throw notFound();
    await file.remove();
    this.files.delete(name);
  }

  /** Test-only: put bytes in a file without going through the store. */
  async seed(name: string, bytes: Uint8Array): Promise<void> {
    const handle = (await this.getFileHandle(name, { create: true })) as FakeFileHandle;
    const writable = (await handle.createWritable()) as FakeWritable;
    writable.write(bytes);
    writable.close();
  }
}

/** A fresh root directory, as `navigator.storage.getDirectory()` would return. */
export function fakeOpfsRoot(): FakeOpfsDirectory {
  return new FakeOpfsDirectory();
}
