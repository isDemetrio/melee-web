/**
 * The single-producer / single-consumer ring the netcode crosses the JS/WASM boundary through.
 *
 * `docs/SPEC_PIANO.md` line 215 puts two of these between the WebRTC data channels and the WASM
 * netcode thread, one per direction, so that neither side ever blocks on the other. The layout is
 * one definition and it is written twice: here and in `wasm/net/sab_ring.h`. Two independent
 * implementations of one byte layout is exactly the kind of thing that diverges silently, so the
 * agreement is a test rather than a comment: `wasm/net/check_sab_ring.mjs` has both sides write the
 * same scripted sequence into a ring and requires the two rings to come out byte-identical, then
 * has each side read the other's ring back. The layout is documented in `docs/NETCODE_MAP.md`,
 * "Transport".
 *
 * Layout, all little-endian, which is WASM memory order:
 *
 *   control block, 16 bytes = four int32 slots, read and published with `Atomics`
 *     0  head      byte offset of the next write, in [0, capacity); producer-owned
 *     1  tail      byte offset of the next read,  in [0, capacity); consumer-owned
 *     2  capacity  bytes of the data region; written once at setup
 *     3  refused   frames the producer did not enqueue for lack of space
 *   data region, `capacity` bytes, starting at byte 16
 *     frame = [u32 payload length][u8 lane][payload]
 *
 * The rules both implementations share:
 *
 *   - `capacity` is a power of two, so the wrap arithmetic is a mask and not a division.
 *   - One byte is left unused: a frame is written only when `used + size < capacity`, so
 *     `head === tail` means "empty" without ambiguity and the ring can never look empty while full.
 *   - A frame may wrap the end of the data region. The producer writes it as at most two segments
 *     and publishes `head` only after both, so a consumer that loads `head` never sees half a
 *     frame; the consumer publishes `tail` only after copying the payload out.
 *   - A zero-byte payload, a payload above `SAB_RING_MAX_FRAME_BYTES` and a lane outside one byte
 *     are not frames. The writer refuses them without touching the ring and without counting them
 *     as back-pressure.
 *
 * This module deliberately imports nothing: it is on the netcode's hot path and it is read by the
 * Node driver in `wasm/net/check_sab_ring.mjs` through Node's type stripping, which resolves
 * specifiers literally.
 */

/** Bytes of control block in front of the data region. */
export const SAB_RING_CONTROL_BYTES = 16;

/** Control slots, in order. */
export const SAB_RING_SLOT_HEAD = 0;
export const SAB_RING_SLOT_TAIL = 1;
export const SAB_RING_SLOT_CAPACITY = 2;
export const SAB_RING_SLOT_REFUSED = 3;

/** `[u32 length][u8 lane]` in front of every payload. */
export const SAB_RING_FRAME_HEADER_BYTES = 5;

/**
 * Largest payload a frame may carry. A cap is what stops a torn length from making a consumer scan
 * the whole ring; the largest Slippi message is a few hundred bytes (`docs/NETCODE_MAP.md`, "Packet
 * formats"), so this is a rejection threshold with room to spare, not a design limit.
 */
export const SAB_RING_MAX_FRAME_BYTES = 1024;

/** Smallest usable data region: one maximum-size frame plus the byte that is left unused. */
export const SAB_RING_MIN_CAPACITY = 2 * SAB_RING_MAX_FRAME_BYTES;

/**
 * Lanes mirror ENet channel use (`port/runtime/hle/slippi_net.cpp:326-327,446-450`): channel 0
 * carries the handshake and character selection and is reliable and ordered; channels 1-2 carry the
 * per-frame guest inputs and are neither.
 */
export const LANE_RELIABLE = 0;
export const LANE_UNRELIABLE = 1;

/** One frame as the consumer sees it. */
export interface SabRingFrame {
  lane: number;
  payload: Uint8Array;
}

/** Diagnostic view of a ring, for tests and for the page's own counters. */
export interface SabRingState {
  head: number;
  tail: number;
  capacity: number;
  usedBytes: number;
  refused: number;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export class SabRing {
  /** The shared memory itself. Both peers need this, not the wrapper. */
  readonly buffer: SharedArrayBuffer;
  /** Data region size in bytes, a power of two. */
  readonly capacity: number;
  private readonly control: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly mask: number;
  /** Scratch for the five-byte frame header, allocated once: this is the hot path. */
  private readonly header: Uint8Array;

  private constructor(buffer: SharedArrayBuffer, capacity: number) {
    this.buffer = buffer;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.control = new Int32Array(buffer, 0, 4);
    this.bytes = new Uint8Array(buffer);
    this.header = new Uint8Array(SAB_RING_FRAME_HEADER_BYTES);
  }

  /** A new ring, with the capacity published in the control block. */
  static create(capacity: number): SabRing {
    if (!isPowerOfTwo(capacity) || capacity < SAB_RING_MIN_CAPACITY) {
      throw new RangeError(
        `sab_ring: capacity must be a power of two of at least ${SAB_RING_MIN_CAPACITY} bytes, got ${capacity}`,
      );
    }
    const ring = new SabRing(
      new SharedArrayBuffer(SAB_RING_CONTROL_BYTES + capacity),
      capacity,
    );
    Atomics.store(ring.control, SAB_RING_SLOT_CAPACITY, capacity);
    return ring;
  }

  /**
   * A ring over memory someone else allocated: a ring handed to a worker, or a ring dumped by the C
   * side and loaded by the Node driver. The capacity comes from the control block, so a dump is
   * self-describing.
   */
  static attach(buffer: SharedArrayBuffer): SabRing {
    if (!(buffer instanceof SharedArrayBuffer)) {
      // Atomics are only legal on shared memory, and a non-shared ring would silently be a private
      // copy rather than a channel between two threads.
      throw new TypeError('sab_ring: the buffer must be a SharedArrayBuffer');
    }
    const control = new Int32Array(buffer, 0, 4);
    const capacity = Atomics.load(control, SAB_RING_SLOT_CAPACITY);
    if (!isPowerOfTwo(capacity) || capacity < SAB_RING_MIN_CAPACITY) {
      throw new RangeError(`sab_ring: the control block does not hold a usable capacity (${capacity})`);
    }
    if (buffer.byteLength !== SAB_RING_CONTROL_BYTES + capacity) {
      throw new RangeError(
        `sab_ring: the buffer is ${buffer.byteLength} bytes, the control block says ${capacity}`,
      );
    }
    return new SabRing(buffer, capacity);
  }

  /**
   * Enqueue one frame. Returns false when the frame was not enqueued: either the ring has no room
   * for it, which is the normal back-pressure the netcode handles by dropping an input packet, or
   * the arguments are not a frame at all. It never waits and never writes partially.
   */
  write(lane: number, payload: Uint8Array): boolean {
    if (!Number.isInteger(lane) || lane < 0 || lane > 255) return false;
    const length = payload.length;
    if (length === 0 || length > SAB_RING_MAX_FRAME_BYTES) return false;

    const size = SAB_RING_FRAME_HEADER_BYTES + length;
    const head = Atomics.load(this.control, SAB_RING_SLOT_HEAD);
    const tail = Atomics.load(this.control, SAB_RING_SLOT_TAIL);
    const used = (head - tail + this.capacity) & this.mask;
    if (used + size >= this.capacity) {
      Atomics.add(this.control, SAB_RING_SLOT_REFUSED, 1);
      return false;
    }

    this.header[0] = length & 0xff;
    this.header[1] = (length >>> 8) & 0xff;
    this.header[2] = (length >>> 16) & 0xff;
    this.header[3] = (length >>> 24) & 0xff;
    this.header[4] = lane;
    this.writeAt(head, this.header);
    this.writeAt((head + SAB_RING_FRAME_HEADER_BYTES) & this.mask, payload);

    // Release: everything above is visible to a consumer that loads `head` after this store.
    Atomics.store(this.control, SAB_RING_SLOT_HEAD, (head + size) & this.mask);
    Atomics.notify(this.control, SAB_RING_SLOT_HEAD, 1);
    return true;
  }

  /**
   * Dequeue one frame, or null when the ring holds no complete frame. The payload is copied: the
   * producer may overwrite it as soon as `tail` moves, so a view into the ring would be invalidated
   * by the next write.
   */
  read(): SabRingFrame | null {
    const head = Atomics.load(this.control, SAB_RING_SLOT_HEAD);
    const tail = Atomics.load(this.control, SAB_RING_SLOT_TAIL);
    const used = (head - tail + this.capacity) & this.mask;
    if (used < SAB_RING_FRAME_HEADER_BYTES) return null;

    this.readAt(tail, this.header);
    const length =
      this.header[0]! | (this.header[1]! << 8) | (this.header[2]! << 16) | (this.header[3]! << 24);
    if (length === 0 || length > SAB_RING_MAX_FRAME_BYTES) {
      // Unreachable if the only writer is this class: a frame is published whole or not at all. It
      // is reachable if a second producer shares the ring, so say so instead of reading garbage.
      throw new Error(
        `sab_ring: frame header at ${tail} declares ${length} bytes; the ring has more than one producer`,
      );
    }
    const size = SAB_RING_FRAME_HEADER_BYTES + length;
    if (used < size) {
      throw new Error(`sab_ring: frame header at ${tail} declares ${length} bytes, ${used} are published`);
    }

    const payload = new Uint8Array(length);
    this.readAt((tail + SAB_RING_FRAME_HEADER_BYTES) & this.mask, payload);
    Atomics.store(this.control, SAB_RING_SLOT_TAIL, (tail + size) & this.mask);
    return { lane: this.header[4]!, payload };
  }

  /** Bytes currently published and unread. */
  usedBytes(): number {
    const head = Atomics.load(this.control, SAB_RING_SLOT_HEAD);
    const tail = Atomics.load(this.control, SAB_RING_SLOT_TAIL);
    return (head - tail + this.capacity) & this.mask;
  }

  /** Bytes a producer may still use. The last byte is never usable, by design. */
  freeBytes(): number {
    return this.capacity - 1 - this.usedBytes();
  }

  /** Frames refused for lack of space since the ring was created. */
  refused(): number {
    return Atomics.load(this.control, SAB_RING_SLOT_REFUSED);
  }

  /** Where the two indices are, for diagnostics and for the C/TypeScript comparison. */
  state(): SabRingState {
    const head = Atomics.load(this.control, SAB_RING_SLOT_HEAD);
    const tail = Atomics.load(this.control, SAB_RING_SLOT_TAIL);
    return {
      head,
      tail,
      capacity: this.capacity,
      usedBytes: (head - tail + this.capacity) & this.mask,
      refused: Atomics.load(this.control, SAB_RING_SLOT_REFUSED),
    };
  }

  /**
   * Copy `source` into the data region at `offset`, splitting at the end of the region. The caller
   * has already checked that the frame fits, so the second segment cannot reach `tail`.
   */
  private writeAt(offset: number, source: Uint8Array): void {
    const first = Math.min(source.length, this.capacity - offset);
    this.bytes.set(source.subarray(0, first), SAB_RING_CONTROL_BYTES + offset);
    if (first < source.length) {
      this.bytes.set(source.subarray(first), SAB_RING_CONTROL_BYTES);
    }
  }

  /** The inverse of `writeAt`. */
  private readAt(offset: number, target: Uint8Array): void {
    const first = Math.min(target.length, this.capacity - offset);
    target.set(this.bytes.subarray(SAB_RING_CONTROL_BYTES + offset, SAB_RING_CONTROL_BYTES + offset + first));
    if (first < target.length) {
      target.set(this.bytes.subarray(SAB_RING_CONTROL_BYTES, SAB_RING_CONTROL_BYTES + target.length - first), first);
    }
  }
}
