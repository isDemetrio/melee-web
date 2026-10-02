import { PAD_STATUS_BYTES } from '../input/pad.js';

// One writer (page), one reader (core worker). A seqlock prevents mixed button/axis samples.
// Word 13 acknowledges presentation, bounding the queue to one ImageBitmap.
export const PRESENTED = 13;
export function createSharedPad(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(14 * Int32Array.BYTES_PER_ELEMENT));
}
export function publishPad(shared: Int32Array, bytes: Uint8Array): void {
  if (bytes.length !== PAD_STATUS_BYTES) throw new Error('Expected one PADStatus');
  Atomics.add(shared, 0, 1);
  for (let i = 0; i < PAD_STATUS_BYTES; i++) Atomics.store(shared, i + 1, bytes[i]!);
  Atomics.add(shared, 0, 1);
}
export function readPad(shared: Int32Array): Uint8Array {
  const bytes = new Uint8Array(PAD_STATUS_BYTES);
  for (;;) {
    const version = Atomics.load(shared, 0);
    if (version & 1) continue;
    for (let i = 0; i < PAD_STATUS_BYTES; i++) bytes[i] = Atomics.load(shared, i + 1);
    if (version === Atomics.load(shared, 0)) return bytes;
  }
}
