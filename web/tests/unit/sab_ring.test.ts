/**
 * The acceptance criteria `docs/PLAN_BREAKDOWN.md` T7 states for the ring, in Node, with no browser
 * and no worker: wraparound, full-buffer back-pressure that returns instead of waiting, zero-length
 * frames refused, and 10^5 random frames round-tripping identically.
 *
 * What this file does not cover, and where it is covered instead: that `wasm/net/sab_ring.h` agrees
 * with `web/src/net/sab_ring.ts` on the byte layout. That needs a C compiler, so it runs in
 * `wasm-probe.yml` through `wasm/net/check_sab_ring.mjs`, which requires the two implementations to
 * write byte-identical rings and has each side read the other's.
 */

import { describe, expect, it } from 'vitest';

import {
  LANE_RELIABLE,
  LANE_UNRELIABLE,
  SabRing,
  SAB_RING_MAX_FRAME_BYTES,
  SAB_RING_MIN_CAPACITY,
} from '../../src/net/sab_ring.js';

/** A deterministic PRNG: a failing case has to be reproducible from the seed alone. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
}

function makePayload(rng: () => number, length: number): Uint8Array {
  const payload = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) payload[i] = rng() & 0xff;
  return payload;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

describe('sab_ring capacity', () => {
  it('requires a power of two large enough for one maximum-size frame', () => {
    expect(() => SabRing.create(1024)).toThrow(RangeError);
    expect(() => SabRing.create(3000)).toThrow(RangeError);
    expect(() => SabRing.create(SAB_RING_MIN_CAPACITY)).not.toThrow();
    expect(SabRing.create(SAB_RING_MIN_CAPACITY).capacity).toBe(SAB_RING_MIN_CAPACITY);
  });

  it('refuses to wrap memory that is not shared', () => {
    // Atomics are only legal on a SharedArrayBuffer, and a ring over a private copy would look
    // like a channel without being one.
    const privateBuffer = new ArrayBuffer(SAB_RING_MIN_CAPACITY + 16);
    expect(() => SabRing.attach(privateBuffer as unknown as SharedArrayBuffer)).toThrow(TypeError);
  });
});

describe('sab_ring frames', () => {
  it('round-trips a frame, lane and all, and reports the ring empty again', () => {
    const ring = SabRing.create(SAB_RING_MIN_CAPACITY);
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    expect(ring.write(LANE_UNRELIABLE, payload)).toBe(true);
    expect(ring.usedBytes()).toBe(5 + payload.length);

    const frame = ring.read();
    expect(frame?.lane).toBe(LANE_UNRELIABLE);
    expect(frame?.payload).toEqual(payload);
    expect(ring.read()).toBeNull();
    expect(ring.usedBytes()).toBe(0);
  });

  it('returns null rather than waiting when nothing is published', () => {
    const ring = SabRing.create(SAB_RING_MIN_CAPACITY);
    expect(ring.read()).toBeNull();
    expect(ring.state()).toEqual({
      head: 0,
      tail: 0,
      capacity: SAB_RING_MIN_CAPACITY,
      usedBytes: 0,
      refused: 0,
    });
  });

  it('refuses a zero-byte payload without touching the ring', () => {
    const ring = SabRing.create(SAB_RING_MIN_CAPACITY);
    expect(ring.write(LANE_RELIABLE, new Uint8Array(0))).toBe(false);
    expect(ring.usedBytes()).toBe(0);
    expect(ring.state().head).toBe(0);
    // Not back-pressure: nothing was refused for lack of space.
    expect(ring.refused()).toBe(0);
  });

  it('refuses a payload above the maximum and a lane outside one byte', () => {
    const ring = SabRing.create(SAB_RING_MIN_CAPACITY);
    expect(ring.write(LANE_RELIABLE, new Uint8Array(SAB_RING_MAX_FRAME_BYTES + 1))).toBe(false);
    expect(ring.write(256, new Uint8Array([7]))).toBe(false);
    expect(ring.write(-1, new Uint8Array([7]))).toBe(false);
    expect(ring.usedBytes()).toBe(0);
    expect(ring.refused()).toBe(0);
  });

  it('accepts a payload of exactly the maximum', () => {
    const ring = SabRing.create(SAB_RING_MIN_CAPACITY);
    const payload = makePayload(makeRng(1), SAB_RING_MAX_FRAME_BYTES);
    expect(ring.write(LANE_RELIABLE, payload)).toBe(true);
    expect(ring.read()?.payload).toEqual(payload);
  });
});

describe('sab_ring wraparound', () => {
  it('carries a frame across the end of the data region', () => {
    const ring = SabRing.create(SAB_RING_MIN_CAPACITY);
    const payload = makePayload(makeRng(2), SAB_RING_MAX_FRAME_BYTES);

    // The first frame ends exactly where the second one has to wrap: the tail has moved to the end
    // of the region, so a frame of the same size cannot be written in one segment.
    expect(ring.write(LANE_UNRELIABLE, payload)).toBe(true);
    const firstHead = ring.state().head;
    expect(firstHead).toBe(SAB_RING_MAX_FRAME_BYTES + 5);
    expect(ring.read()?.payload).toEqual(payload);

    expect(ring.write(LANE_RELIABLE, payload)).toBe(true);
    const secondHead = ring.state().head;
    expect(secondHead).toBeLessThan(firstHead);

    const frame = ring.read();
    expect(frame?.lane).toBe(LANE_RELIABLE);
    expect(sameBytes(frame?.payload ?? new Uint8Array(0), payload)).toBe(true);
    expect(ring.usedBytes()).toBe(0);
  });
});

describe('sab_ring back-pressure', () => {
  it('returns false when the ring is full instead of waiting or overwriting', () => {
    const ring = SabRing.create(SAB_RING_MIN_CAPACITY);
    const payload = makePayload(makeRng(3), 100);
    let accepted = 0;
    for (let i = 0; i < 100; i += 1) {
      if (ring.write(LANE_UNRELIABLE, payload)) accepted += 1;
    }
    // A 2048-byte ring holds nineteen 105-byte frames; the last byte is never usable.
    expect(accepted).toBe(19);
    expect(ring.usedBytes()).toBe(1995);
    expect(ring.freeBytes()).toBe(SAB_RING_MIN_CAPACITY - 1 - 1995);
    expect(ring.refused()).toBe(100 - accepted);
    // Nothing was lost that was written: every accepted frame is still there, in order.
    for (let i = 0; i < accepted; i += 1) {
      expect(ring.read()?.payload).toEqual(payload);
    }
    expect(ring.read()).toBeNull();

    // Room again, and the refused counter is history, not state.
    expect(ring.write(LANE_UNRELIABLE, payload)).toBe(true);
    expect(ring.read()?.payload).toEqual(payload);
  });
});

describe('sab_ring under load', () => {
  it('round-trips 10^5 random frames identically', () => {
    const ring = SabRing.create(4096);
    const rng = makeRng(0xc0ffee);
    // Frames that were written and not read back yet, in order: the ring must return exactly these.
    const inFlight: { lane: number; payload: Uint8Array }[] = [];
    let written = 0;
    let read = 0;
    let mismatches = 0;
    let refused = 0;

    for (let i = 0; i < 100_000; i += 1) {
      const lane = rng() & 1;
      const payload = makePayload(rng, 1 + (rng() % 64));
      if (ring.write(lane, payload)) {
        written += 1;
        inFlight.push({ lane, payload });
      } else {
        refused += 1;
      }

      if (i % 2 === 1) {
        const frame = ring.read();
        if (frame !== null) {
          const expected = inFlight.shift();
          if (
            expected === undefined ||
            frame.lane !== expected.lane ||
            !sameBytes(frame.payload, expected.payload)
          ) {
            mismatches += 1;
          }
          read += 1;
        }
      }
    }

    expect(mismatches).toBe(0);
    expect(written).toBe(100_000 - refused);
    expect(read + inFlight.length).toBe(written);
    // The ring must have been full at some point, or this is not a test of a bounded ring.
    expect(refused).toBeGreaterThan(0);

    while (inFlight.length > 0) {
      const frame = ring.read();
      expect(frame).not.toBeNull();
      const expected = inFlight.shift();
      if (
        frame === null ||
        expected === undefined ||
        frame.lane !== expected.lane ||
        !sameBytes(frame.payload, expected.payload)
      ) {
        mismatches += 1;
      }
    }
    expect(mismatches).toBe(0);
    expect(ring.read()).toBeNull();
    expect(ring.usedBytes()).toBe(0);
  });
});
