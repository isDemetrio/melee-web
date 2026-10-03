import { describe, expect, it } from 'vitest';
import { DISC_DIRECTORY, DISC_FILE_NAME, openCachedDisc, readDiscThrough, type OpfsDirectory,
  type SyncReadHandle } from '../../src/play/disc-reader';
import { COLUMN, createFlight, FrameMeter, meterDiscReads } from '../../src/play/frame-meter';
import * as opfsWorker from '../../src/spike/opfs-worker';

const IDENTITY = 'ab'.repeat(32);

/** A handle over `bytes` that records every read it serves. */
function fakeHandle(bytes: Uint8Array, short = 0) {
  const reads: [at: number, length: number][] = [];
  const handle: SyncReadHandle = {
    getSize: () => bytes.length,
    read(buffer, { at }) {
      reads.push([at, buffer.length]);
      const count = Math.max(0, Math.min(buffer.length, bytes.length - at) - short);
      buffer.set(bytes.subarray(at, at + count));
      return count;
    },
    close() { /* fake */ },
  };
  return { handle, reads };
}

/** WORKERFS's read, as the core ships it: a slice and FileReaderSync. Counts its calls. */
function fakeWorkerfs() {
  const calls: number[] = [];
  const stream_ops = {
    read(stream: { node: { contents: Blob } }, buffer: Int8Array, offset: number, length: number, position: number): number {
      calls.push(position);
      buffer.fill(7, offset, offset + length);
      return Math.min(length, stream.node.contents.size - position);
    },
  };
  return { filesystems: { WORKERFS: { stream_ops } }, stream_ops, calls };
}

const disc = new Uint8Array(4096).map((_, i) => i * 31 % 251);
const discFile = new Blob([disc]);
const stream = (contents: Blob) => ({ node: { contents, size: contents.size } });

describe('disc reader', () => {
  it('keeps the cache names of the OPFS worker', () => {
    expect(DISC_DIRECTORY).toBe(opfsWorker.DISC_DIRECTORY);
    expect(DISC_FILE_NAME).toBe(opfsWorker.DISC_FILE_NAME);
    expect(opfsWorker.IDENTITY_PATTERN.test(IDENTITY)).toBe(true);
  });

  it('opens the cached disc of one identity, creating nothing', async () => {
    const walked: string[] = [];
    const { handle } = fakeHandle(disc);
    const directory = (path: string): OpfsDirectory => ({
      async getDirectoryHandle(name, options) {
        expect(options).toEqual({ create: false });
        walked.push(`${path}/${name}`);
        return directory(`${path}/${name}`);
      },
      async getFileHandle(name, options) {
        expect(options).toEqual({ create: false });
        walked.push(`${path}/${name}`);
        return { createSyncAccessHandle: async () => handle };
      },
    });
    expect(await openCachedDisc(async () => directory(''), IDENTITY)).toBe(handle);
    expect(walked).toEqual([`/${DISC_DIRECTORY}`, `/${DISC_DIRECTORY}/${IDENTITY}`,
      `/${DISC_DIRECTORY}/${IDENTITY}/${DISC_FILE_NAME}`]);
  });

  it('refuses an identity that is not one, and passes the platform\'s refusal on', async () => {
    await expect(openCachedDisc(async () => { throw new Error('unreachable'); }, '../x')).rejects.toThrow(/identity/);
    const missing = Object.assign(new Error('no such file'), { name: 'NotFoundError' });
    await expect(openCachedDisc(async () => { throw missing; }, IDENTITY)).rejects.toBe(missing);
  });

  it('reads the disc through the handle, into the heap at the offset the core gave', () => {
    const fs = fakeWorkerfs();
    const { handle, reads } = fakeHandle(disc);
    readDiscThrough(fs.filesystems, discFile, handle);
    const heap = new Int8Array(64);
    expect(fs.stream_ops.read(stream(discFile), heap, 8, 31, 1000)).toBe(31);
    expect(new Uint8Array(heap.buffer, 8, 31)).toEqual(disc.subarray(1000, 1031));
    expect(heap[7]).toBe(0);
    expect(heap[39]).toBe(0);
    expect(reads).toEqual([[1000, 31]]);
    expect(fs.calls).toEqual([]);
  });

  it('stops at the end of the disc, and leaves other files to WORKERFS', () => {
    const fs = fakeWorkerfs();
    const { handle, reads } = fakeHandle(disc);
    readDiscThrough(fs.filesystems, discFile, handle);
    const heap = new Int8Array(64);
    expect(fs.stream_ops.read(stream(discFile), heap, 0, 64, 4090)).toBe(6);
    expect(fs.stream_ops.read(stream(discFile), heap, 0, 64, 4096)).toBe(0);
    expect(reads).toEqual([[4090, 6]]);
    const other = new Blob([new Uint8Array(100)]);
    expect(fs.stream_ops.read(stream(other), heap, 0, 10, 5)).toBe(10);
    expect(fs.calls).toEqual([5]);
  });

  it('throws on a short read rather than handing the core missing bytes', () => {
    const fs = fakeWorkerfs();
    readDiscThrough(fs.filesystems, discFile, fakeHandle(disc, 1).handle);
    expect(() => fs.stream_ops.read(stream(discFile), new Int8Array(64), 0, 32, 0))
      .toThrow('disc read failed: 31 of 32 bytes at 0');
  });

  it('refuses a handle whose file is not the disc, or a core without WORKERFS', () => {
    expect(() => readDiscThrough(fakeWorkerfs().filesystems, discFile, fakeHandle(disc.subarray(1)).handle))
      .toThrow('the cached disc file holds 4095 bytes, the disc 4096');
    expect(() => readDiscThrough({}, discFile, fakeHandle(disc).handle)).toThrow(/WORKERFS/);
  });

  it('is what the frame meter times when it is installed first', () => {
    const fs = fakeWorkerfs();
    let clock = 0;
    const { handle } = fakeHandle(disc);
    const timed: SyncReadHandle = { ...handle, read: (buffer, options) => { clock += 2; return handle.read(buffer, options); } };
    readDiscThrough(fs.filesystems, discFile, timed);
    const meter = new FrameMeter(createFlight(), () => clock);
    expect(meterDiscReads(fs.filesystems, meter)).toBeNull();
    meter.start();
    fs.stream_ops.read(stream(discFile), new Int8Array(2048), 0, 1024, 0);
    fs.stream_ops.read(stream(discFile), new Int8Array(2048), 0, 31, 2048);
    meter.coreEnd(1, null, null);
    meter.bitmapDone();
    meter.ackDone();
    const row = meter.cycleEnd().row;
    expect([row[COLUMN.disc_ms], row[COLUMN.disc_bytes]]).toEqual([4, 1055]);
    expect(fs.calls).toEqual([]);
  });
});
