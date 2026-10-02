/**
 * The C and TypeScript halves of the ring agree byte-for-byte, measured instead of asserted.
 *
 * `web/src/net/sab_ring.ts` and `wasm/net/sab_ring.h` are two implementations of one layout
 * (`docs/NETCODE_MAP.md`, "Transport"). A layout written twice diverges silently -- an offset, an
 * endianness, the treatment of a frame that wraps -- so this driver makes both halves write the
 * same scripted sequence into a ring of the same size and requires the two rings to come out
 * byte-identical, then has each half read the other's ring back:
 *
 *   1. TypeScript writes the sequence  -> ts-ring.bin
 *   2. C writes the sequence           -> c-ring.bin, and prints the state it ended in
 *   3. the two dumps must be identical, byte for byte
 *   4. C reads ts-ring.bin with its own reader and compares every frame against the sequence
 *   5. TypeScript reads c-ring.bin with its own reader and compares every frame the same way
 *
 * The sequence is fixed rather than random so a failure is reproducible: one PRNG (xorshift32,
 * seed 0x1f123bb5) feeds both halves, and the same stream produces the same payload bytes in C and
 * in JavaScript. It is built to exercise the cases a layout can disagree on:
 *
 *   - a zero-byte payload, a payload above the maximum and a lane outside one byte, all three
 *     refused on an empty ring, which is where "not a frame" is not the same thing as "full";
 *   - frames that wrap the end of the data region, which both halves report and this driver
 *     requires to have happened;
 *   - a ring that fills up, so the producer is refused and `refused` counts it;
 *   - reads interleaved with writes, so the tail moves and the ring is not a plain queue.
 *
 * Usage: node wasm/net/check_sab_ring.mjs <sab_ring_test.js> [output-directory]
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SabRing, SAB_RING_MAX_FRAME_BYTES } from '../../web/src/net/sab_ring.ts';

/** The one capacity both halves use: a power of two, small enough to fill in 64 rounds. */
export const RING_CAPACITY = 2048;
export const RNG_SEED = 0x1f123bb5;
export const ROUNDS = 64;

/** FNV-1a, 32 bit: the frame identity both halves compare, with no crypto dependency. */
export function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
}

function makeFifo() {
  const items = [];
  return {
    push(item) {
      items.push(item);
    },
    take() {
      return items.shift();
    },
    drain() {
      return items.splice(0, items.length);
    },
  };
}

/**
 * Run the scripted sequence against a ring, and say what a reader should still find in it.
 *
 * `remaining` is the FIFO of frames written and not read back during the sequence: that is what the
 * ring must still hold afterwards, so the other half can verify a dump against it.
 */
export function runScript(ring) {
  const rng = makeRng(RNG_SEED);
  const remaining = makeFifo();
  const result = {
    notFrames: 0,
    written: 0,
    refusedFull: 0,
    read: 0,
    wrapped: false,
    mismatch: null,
  };

  // Three writes that are not frames, on an empty ring. None may enter the ring, and none of them
  // is back-pressure, so `refused` must stay zero.
  const candidates = [
    { lane: 0, payload: new Uint8Array(0) },
    { lane: 0, payload: new Uint8Array(SAB_RING_MAX_FRAME_BYTES + 1) },
    { lane: 256, payload: new Uint8Array(1) },
  ];
  for (const candidate of candidates) {
    if (ring.write(candidate.lane, candidate.payload) !== false) {
      result.mismatch ??= 'a write that is not a frame was accepted';
    }
    result.notFrames += 1;
  }
  const empty = ring.state();
  if (empty.usedBytes !== 0 || empty.head !== 0 || empty.tail !== 0 || empty.refused !== 0) {
    result.mismatch ??= 'a write that is not a frame changed the ring';
  }

  for (let round = 0; round < ROUNDS; round += 1) {
    const lane = round & 1;
    const length = 1 + (rng() % 300);
    const payload = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) payload[i] = rng() & 0xff;

    const headBefore = ring.state().head;
    if (ring.write(lane, payload)) {
      result.written += 1;
      if (ring.state().head <= headBefore) result.wrapped = true;
      remaining.push({ lane, length, fnv: fnv1a32(payload) });
    } else {
      result.refusedFull += 1;
    }

    if (round % 3 === 2) {
      const frame = ring.read();
      if (frame !== null) {
        result.read += 1;
        const expected = remaining.take();
        if (expected === undefined) {
          result.mismatch ??= `round ${round}: the ring returned a frame that was never written`;
        } else if (frame.lane !== expected.lane || frame.payload.length !== expected.length) {
          result.mismatch ??= `round ${round}: read lane/length ${frame.lane}/${frame.payload.length}, wrote ${expected.lane}/${expected.length}`;
        } else if (fnv1a32(frame.payload) !== expected.fnv) {
          result.mismatch ??= `round ${round}: the payload differs from what was written`;
        }
      }
    }
  }

  return { ...result, state: ring.state(), remaining: remaining.drain() };
}

/** Serialise the whole ring -- control block and data region -- as one image. */
export function dumpRing(ring, path) {
  writeFileSync(path, new Uint8Array(ring.buffer));
}

/** Load a ring image into shared memory, which is what a working ring requires. */
export function loadRing(path) {
  const image = readFileSync(path);
  const buffer = new SharedArrayBuffer(image.byteLength);
  new Uint8Array(buffer).set(image);
  return SabRing.attach(buffer);
}

/** The `state ...` line the C half prints, as numbers. */
function cState(stdout, label) {
  const line = stdout.split('\n').find((row) => row.startsWith('state '));
  if (!line) throw new Error(`${label}: no state line in the C output:\n${stdout}`);
  const state = {};
  for (const [, key, value] of line.matchAll(/(\w+)=(-?\d+)/g)) state[key] = Number(value);
  return state;
}

function runC(binary, args, label) {
  const run = spawnSync(process.execPath, [binary, ...args], { encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status !== 0) throw new Error(`${label}: the C half exited ${run.status}\n${output}`);
  if (!output.includes(label)) throw new Error(`${label}: the C half did not report success\n${output}`);
  return output;
}

function main() {
  const binary = process.argv[2];
  if (!binary) {
    throw new Error('usage: node wasm/net/check_sab_ring.mjs <sab_ring_test.js> [output-directory]');
  }
  const outDir = resolve(
    process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wasm-probe', 'out', 'ring'),
  );
  mkdirSync(outDir, { recursive: true });

  const tsRing = SabRing.create(RING_CAPACITY);
  const tsRun = runScript(tsRing);
  if (tsRun.mismatch) throw new Error(`TypeScript: ${tsRun.mismatch}`);
  const tsPath = join(outDir, 'ts-ring.bin');
  const cPath = join(outDir, 'c-ring.bin');
  dumpRing(tsRing, tsPath);

  // C writes the same sequence, reads the TypeScript dump with its own reader, and reports the
  // state it ended in.
  const produceOutput = runC(binary, ['--produce', cPath], 'PRODUCE OK');
  const cRun = cState(produceOutput, 'the C producer');
  runC(binary, ['--consume', tsPath], 'CONSUME OK');

  const tsImage = readFileSync(tsPath);
  const cImage = readFileSync(cPath);
  if (!tsImage.equals(cImage)) {
    let first = -1;
    for (let i = 0; i < Math.min(tsImage.length, cImage.length); i += 1) {
      if (tsImage[i] !== cImage[i]) {
        first = i;
        break;
      }
    }
    throw new Error(
      `the two rings differ: TypeScript ${tsImage.length} bytes, C ${cImage.length} bytes, first difference at byte ${first}`,
    );
  }

  for (const key of ['head', 'tail', 'capacity', 'refused']) {
    if (cRun[key] !== tsRun.state[key]) {
      throw new Error(`the C producer ended with ${key}=${cRun[key]}, TypeScript with ${tsRun.state[key]}`);
    }
  }
  if (cRun.wrapped !== 1) throw new Error('the C half did not report a frame wrapping the data region');

  // TypeScript reads what C wrote, and finds exactly the frames the sequence left behind.
  const cRing = loadRing(cPath);
  const drained = [];
  for (;;) {
    const frame = cRing.read();
    if (frame === null) break;
    drained.push({ lane: frame.lane, length: frame.payload.length, fnv: fnv1a32(frame.payload) });
  }
  if (drained.length !== tsRun.remaining.length) {
    throw new Error(
      `TypeScript read ${drained.length} frames from the C ring, the sequence left ${tsRun.remaining.length}`,
    );
  }
  for (let i = 0; i < drained.length; i += 1) {
    const got = drained[i];
    const want = tsRun.remaining[i];
    if (got.lane !== want.lane || got.length !== want.length || got.fnv !== want.fnv) {
      throw new Error(`frame ${i} of the C ring does not match the sequence`);
    }
  }
  const readBack = cRing.state();
  if (readBack.head !== tsRun.state.head || readBack.refused !== tsRun.state.refused) {
    throw new Error('the C ring, read back by TypeScript, does not end where the sequence ended');
  }

  if (!tsRun.wrapped) throw new Error('the TypeScript half did not wrap a frame');
  if (tsRun.refusedFull === 0) throw new Error('the sequence must fill the ring at least once');

  console.log('sab_ring: the two halves agree, byte for byte');
  console.log(
    JSON.stringify(
      {
        capacity: RING_CAPACITY,
        rounds: ROUNDS,
        written: tsRun.written,
        refused_full: tsRun.refusedFull,
        refused_not_frames: tsRun.notFrames,
        read_during_sequence: tsRun.read,
        left_in_ring: drained.length,
        ring_bytes: tsImage.length,
        state: tsRun.state,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
