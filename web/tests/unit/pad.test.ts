import { describe, expect, it } from 'vitest';
import {
  PAD,
  PAD_ACTIONS,
  PAD_BUTTON_BITS,
  PAD_STATUS_BYTES,
  applyDeadzone,
  clampStick,
  clampTrigger,
  deadzoneRadius,
  disconnectedPad,
  freshDataMask,
  neutralPad,
  padStatusBytes,
  writePadStatus,
} from '../../src/input/pad.js';

describe('PAD state layout', () => {
  it('uses the GameCube button bits from the port, not Dolphin’s or the Gamepad API’s', () => {
    // host/input_bindings.h:64-67, kActionPadBit in BindAction order
    // (A, B, X, Y, Z, Start, L, R, DUp, DDown, DLeft, DRight).
    expect(PAD.A).toBe(0x0100);
    expect(PAD.B).toBe(0x0200);
    expect(PAD.X).toBe(0x0400);
    expect(PAD.Y).toBe(0x0800);
    expect(PAD.Z).toBe(0x0010);
    expect(PAD.Start).toBe(0x1000);
    expect(PAD.L).toBe(0x0040);
    expect(PAD.R).toBe(0x0020);
    expect(PAD.Up).toBe(0x0008);
    expect(PAD.Down).toBe(0x0004);
    expect(PAD.Left).toBe(0x0001);
    expect(PAD.Right).toBe(0x0002);
  });

  it('has no button bit for the stick and C-stick directions', () => {
    // They push an axis; the upstream table has zeros for them. A bit here would make a
    // direction press look like a button press to the guest.
    for (const action of ['CUp', 'CDown', 'CLeft', 'CRight', 'SUp', 'SDown', 'SLeft', 'SRight']) {
      expect(PAD_BUTTON_BITS[action as keyof typeof PAD_BUTTON_BITS]).toBeUndefined();
    }
    expect(Object.keys(PAD_BUTTON_BITS)).toHaveLength(12);
  });

  it('lists every action once, in the upstream enum order', () => {
    expect(PAD_ACTIONS).toHaveLength(20);
    expect(new Set(PAD_ACTIONS).size).toBe(20);
    expect(PAD_ACTIONS.slice(0, 6)).toEqual(['A', 'B', 'X', 'Y', 'Z', 'Start']);
    expect(PAD_ACTIONS.slice(16)).toEqual(['SUp', 'SDown', 'SLeft', 'SRight']);
  });

  it('reports a neutral pad as present and a disconnected one as absent', () => {
    const neutral = neutralPad();
    expect(neutral.err).toBe(0);
    expect(neutral.button).toBe(0);
    expect(neutral.stickX).toBe(0);
    expect(neutral.stickY).toBe(0);
    expect(neutral.subX).toBe(0);
    expect(neutral.subY).toBe(0);
    expect(neutral.trigL).toBe(0);
    expect(neutral.trigR).toBe(0);

    expect(disconnectedPad().err).toBe(-1);
    // Nothing else differs: a port with no device is a neutral pad the guest must ignore.
    expect({ ...disconnectedPad(), err: 0 }).toEqual(neutralPad());
  });

  it('serialises one PADStatus exactly as PADRead writes it', () => {
    // hle_pad.cpp:55-70: wr16 for the button (big-endian, host.cpp:211 byteswaps), one byte
    // each for the rest, signed fields as two's complement, byte 11 always zero.
    const bytes = padStatusBytes({
      button: PAD.A | PAD.Z,
      stickX: -127,
      stickY: 127,
      subX: -1,
      subY: 1,
      trigL: 255,
      trigR: 128,
      analogA: 0,
      analogB: 0,
      err: 0,
    });
    expect(bytes.length).toBe(PAD_STATUS_BYTES);
    expect([...bytes]).toEqual([
      0x01, 0x10, // button, big-endian
      0x81, 0x7f, // stick_x, stick_y
      0xff, 0x01, // sub_x, sub_y
      0xff, 0x80, // trig_l, trig_r
      0x00, 0x00, // analog_a, analog_b
      0x00, 0x00, // err, padding
    ]);
  });

  it('writes err = -1 as one byte, so the guest sees an unplugged port', () => {
    const bytes = padStatusBytes(disconnectedPad());
    expect(bytes[10]).toBe(0xff);
    expect(bytes[11]).toBe(0);
  });

  it('writes into an existing buffer at an offset, and refuses a buffer that is too small', () => {
    const buffer = new Uint8Array(16).fill(0xaa);
    writePadStatus({ ...neutralPad(), button: PAD.B }, buffer, 4);
    expect(buffer[0]).toBe(0xaa); // untouched before the offset
    expect(buffer[4]).toBe(0x02);
    expect(buffer[5]).toBe(0x00);
    expect(() => writePadStatus(neutralPad(), new Uint8Array(11))).toThrow(RangeError);
  });

  it('never lets a stray high bit corrupt the button field', () => {
    const bytes = padStatusBytes({ ...neutralPad(), button: 0x10000 | PAD.A });
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x00);
  });

  it('reports fresh data only for the ports that have a pad', () => {
    // PADRead: mask |= 0x80000000 >> i when err == 0 (hle_pad.cpp:70).
    const mask = freshDataMask([neutralPad(), disconnectedPad(), neutralPad(), disconnectedPad()]);
    expect(mask).toBe((0x80000000 | 0x20000000) >>> 0);
    expect(freshDataMask([disconnectedPad()])).toBe(0);
    expect(freshDataMask([])).toBe(0);
    expect(freshDataMask([neutralPad()])).toBe(0x80000000);
  });
});

describe('stick and trigger ranges', () => {
  it('clamps a stick to one signed byte and truncates toward zero', () => {
    expect(clampStick(0)).toBe(0);
    expect(clampStick(63.9)).toBe(63);
    expect(clampStick(-63.9)).toBe(-63);
    expect(clampStick(127)).toBe(127);
    expect(clampStick(-127)).toBe(-127);
    expect(clampStick(128)).toBe(127);
    expect(clampStick(-300)).toBe(-127);
  });

  it('treats a non-finite stick value as neutral, never as full deflection', () => {
    // A pad that reports NaN or Infinity must not walk the character into the wall.
    expect(clampStick(Number.NaN)).toBe(0);
    expect(clampStick(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampStick(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('clamps a trigger to 0..255 and rounds to the nearest step', () => {
    expect(clampTrigger(0)).toBe(0);
    expect(clampTrigger(-5)).toBe(0);
    expect(clampTrigger(200.4)).toBe(200);
    expect(clampTrigger(200.6)).toBe(201);
    expect(clampTrigger(255)).toBe(255);
    expect(clampTrigger(999)).toBe(255);
    expect(clampTrigger(Number.NaN)).toBe(0);
  });
});

describe('deadzone', () => {
  it('converts a fraction to the panel’s own units (the panel divides by 80)', () => {
    // gx/pc_settings.cpp:5731 shows the deadzone as deadzone/80, so a fraction is * 80 here.
    expect(deadzoneRadius(0.25)).toBe(20);
    expect(deadzoneRadius(1)).toBe(80);
    expect(deadzoneRadius(0)).toBe(0);
    expect(deadzoneRadius(-1)).toBe(0);
    expect(deadzoneRadius(Number.NaN)).toBe(0);
  });

  it('zeroes both axes inside the radius and leaves them alone outside it', () => {
    // apply_deadzone (host/input_bindings.h:226-229): circular test, no rescaling.
    expect(applyDeadzone(10, 10, 20)).toEqual({ x: 0, y: 0 });
    expect(applyDeadzone(20, 0, 20)).toEqual({ x: 20, y: 0 }); // on the rim is outside
    expect(applyDeadzone(0, 21, 20)).toEqual({ x: 0, y: 21 });
    expect(applyDeadzone(-14, -14, 20)).toEqual({ x: 0, y: 0 });
    expect(applyDeadzone(127, 0, 0)).toEqual({ x: 127, y: 0 });
    expect(applyDeadzone(3, 4, 5)).toEqual({ x: 3, y: 4 }); // exactly on the rim, 5 !< 5
  });
});
