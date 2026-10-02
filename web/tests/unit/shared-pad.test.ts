import { describe, expect, it } from 'vitest';
import { createSharedPad, PRESENTED, publishPad, readPad } from '../../src/play/shared-pad.js';
import { PAD, neutralPad, padStatusBytes } from '../../src/input/pad.js';

describe('live PAD mailbox', () => {
  it('preserves guest byte order, signed axes and triggers independently of presentation', () => {
    const shared = createSharedPad();
    const bytes = padStatusBytes({ ...neutralPad(), button: PAD.A | PAD.Start,
      stickX: -127, stickY: 127, trigL: 200 });
    Atomics.store(shared, PRESENTED, 42);
    publishPad(shared, bytes);
    expect([...readPad(shared)]).toEqual([0x11, 0, 129, 127, 0, 0, 200, 0, 0, 0, 0, 0]);
    expect(Atomics.load(shared, PRESENTED)).toBe(42);
    publishPad(shared, padStatusBytes(neutralPad()));
    expect([...readPad(shared)]).toEqual(Array(12).fill(0));
    expect(Atomics.load(shared, 0) % 2).toBe(0);
  });
  it('rejects incomplete samples before opening a write transaction', () => {
    const shared = createSharedPad();
    expect(() => publishPad(shared, new Uint8Array(3))).toThrow('PADStatus');
    expect(Atomics.load(shared, 0)).toBe(0);
  });
});
