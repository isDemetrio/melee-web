/**
 * How the play worker reads the disc during a game: through an OPFS sync access handle on the
 * cached disc, not through WORKERFS's `FileReaderSync`.
 *
 * Why it matters (docs/PROGRESS.md, "Disc stalls"): WORKERFS reads every slice of the disc with
 * `FileReaderSync.readAsArrayBuffer`, which on WebKit is a synchronous blob load: the worker spins
 * its own run loop (`WorkerDedicatedRunLoop::runInMode`) until the load is done. Since WebKit
 * 302518@main ("Work around CF timers not being serviced promptly"), that run loop blocks for up to
 * one second when a CFRunLoop timer of the thread is overdue by more than one second. The play
 * worker never returns to its run loop while `callMain` runs, so its timers go overdue between two
 * reads; the music stream reads once every ~107 retraces in a match, and each of those reads paid
 * the full second (1.00-1.05 s in every operator report, whatever the size of the read).
 *
 * `FileSystemSyncAccessHandle.read` is a seek and a read on a file handle the worker holds: no
 * blob load, no run loop. The handle is opened before `callMain`, while the worker can still await.
 *
 * Only the cached disc has a handle: a disc picked with the file selector is a `File` and keeps
 * `FileReaderSync`, with a note in the report saying so.
 */

import { openSyncHandle, type Wait } from '../spike/sync-handle.js';

/**
 * Where `web/src/spike/opfs-worker.ts` keeps the cached disc. Repeated here because importing that
 * module registers its request handler on whatever worker loads it, which here would be the play
 * worker; `web/tests/unit/disc-reader.test.ts` asserts the two copies agree.
 */
export const DISC_DIRECTORY = 'phase0-disc';
export const DISC_FILE_NAME = 'melee-ntsc102.iso';
const IDENTITY_PATTERN = /^[0-9a-f]{64}$/;

/** The part of `FileSystemSyncAccessHandle` the reader uses. */
export interface SyncReadHandle {
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  close(): void;
}

/** The part of OPFS the opener walks: directories, then the file. */
export interface OpfsDirectory {
  getDirectoryHandle(name: string, options: { create: false }): Promise<OpfsDirectory>;
  getFileHandle(name: string, options: { create: false }): Promise<{ createSyncAccessHandle(): Promise<SyncReadHandle> }>;
}

/**
 * The cached disc of one cache identity, opened for synchronous reads. Rejects with the platform's
 * own error when the file is missing; a handle that holds the file is waited for while it may be
 * one being released, then reported (`openSyncHandle`: another tab playing, say).
 */
export async function openCachedDisc(root: () => Promise<OpfsDirectory>, identity: string,
  wait?: Wait): Promise<SyncReadHandle> {
  if (!IDENTITY_PATTERN.test(identity)) throw new Error(`not a disc cache identity: ${identity}`);
  const parent = await (await root()).getDirectoryHandle(DISC_DIRECTORY, { create: false });
  const directory = await parent.getDirectoryHandle(identity, { create: false });
  const file = await directory.getFileHandle(DISC_FILE_NAME, { create: false });
  return openSyncHandle(file, wait);
}

/** What WORKERFS hands `stream_ops.read`: the stream's node holds the mounted `File`. */
interface DiscStream { node: { contents: unknown; size: number } }
type Read = (stream: DiscStream, buffer: Int8Array | Uint8Array, offset: number, length: number, position: number) => number;

/**
 * Route WORKERFS's reads of `disc` to `handle`; every other mounted file keeps its own read. Call it
 * before `meterDiscReads`, so the meter wraps this read and `disc_ms` keeps measuring what the core
 * waits for. The handle must hold exactly the bytes of `disc`: a size that differs is refused here,
 * and a read that comes back short throws, so the core stops with the reason instead of running on
 * missing bytes.
 */
export function readDiscThrough(filesystems: Record<string, unknown>, disc: Blob, handle: SyncReadHandle): void {
  const ops = (filesystems['WORKERFS'] as { stream_ops?: Record<string, unknown> } | undefined)?.stream_ops;
  const original = ops?.['read'];
  if (!ops || typeof original !== 'function') throw new Error('WORKERFS.stream_ops.read not found');
  const size = handle.getSize();
  if (size !== disc.size) throw new Error(`the cached disc file holds ${size} bytes, the disc ${disc.size}`);
  const fallback = original as Read;
  ops['read'] = function handleRead(this: unknown, stream: DiscStream, buffer: Int8Array | Uint8Array, offset: number,
    length: number, position: number): number {
    if (stream.node.contents !== disc) return fallback.call(this, stream, buffer, offset, length, position);
    if (position >= size) return 0;
    const count = Math.min(length, size - position);
    const read = handle.read(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, count), { at: position });
    if (read !== count) throw new Error(`disc read failed: ${read} of ${count} bytes at ${position}`);
    return read;
  };
}
