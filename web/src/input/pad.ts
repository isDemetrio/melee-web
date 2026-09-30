/**
 * The one PAD state every input source writes into.
 *
 * Vocabulary and layout are the port's, not invented here: this is `host::PadState` from the
 * upstream runtime (`upstream/melee-unlocked/port/runtime/host/host.h:160`) and it is
 * serialised into the guest's 12-byte `PADStatus` exactly the way the upstream `PADRead` HLE
 * does it (`upstream/melee-unlocked/port/runtime/hle/hle_pad.cpp:55-70`):
 *
 *   +0  u16 button      big-endian in guest memory (`host::wr16` byteswaps, host.cpp:211)
 *   +2  i8  stick_x     control stick, -127..127, positive = right
 *   +3  i8  stick_y     control stick, -127..127, positive = up
 *   +4  i8  sub_x       C-stick, same convention
 *   +5  i8  sub_y       C-stick, same convention
 *   +6  u8  trig_l      0..255 analog L
 *   +7  u8  trig_r      0..255 analog R
 *   +8  u8  analog_a    unused by every device the upstream supports; kept so the layout matches
 *   +9  u8  analog_b    likewise
 *   +10 i8  err         0 = a pad is present, -1 = not connected
 *   +11 u8  padding     always zero
 *
 * Two consequences worth stating because they are easy to get wrong:
 *  - The button bits are the GameCube ones, taken verbatim from the port's `kActionPadBit`
 *    table (`host/input_bindings.h:64-67`), not Dolphin's or the Gamepad API's numbering.
 *  - `stick_y` is positive UP. The Gamepad API reports its Y axes positive DOWN, so the
 *    gamepad reader negates them; the keyboard writes them directly. See gamepad.ts.
 *
 * Nothing in this module touches the DOM, `navigator` or `Math.random`, so it is a pure
 * function of its arguments and runs unchanged under Node in the unit tests.
 */

/** GameCube button bits, in the port's own numbering. Values are asserted by tests. */
export const PAD = {
  Left: 0x0001,
  Right: 0x0002,
  Down: 0x0004,
  Up: 0x0008,
  Z: 0x0010,
  R: 0x0020,
  L: 0x0040,
  A: 0x0100,
  B: 0x0200,
  X: 0x0400,
  Y: 0x0800,
  Start: 0x1000,
} as const;

/** Bit index of one button, as `host::BindAction` names them. */
export type PadButton = keyof typeof PAD;

/**
 * The actions a source can be bound to, in the same order as the upstream `BindAction` enum.
 * The two stick groups exist because a device without an analog stick (keyboard, box
 * controller) pushes the stick with a button instead — `apply_stick_actions` upstream.
 */
export type PadAction =
  | 'A'
  | 'B'
  | 'X'
  | 'Y'
  | 'Z'
  | 'Start'
  | 'L'
  | 'R'
  | 'DUp'
  | 'DDown'
  | 'DLeft'
  | 'DRight'
  | 'CUp'
  | 'CDown'
  | 'CLeft'
  | 'CRight'
  | 'SUp'
  | 'SDown'
  | 'SLeft'
  | 'SRight';

export const PAD_ACTIONS: readonly PadAction[] = [
  'A', 'B', 'X', 'Y', 'Z', 'Start', 'L', 'R',
  'DUp', 'DDown', 'DLeft', 'DRight',
  'CUp', 'CDown', 'CLeft', 'CRight',
  'SUp', 'SDown', 'SLeft', 'SRight',
];

/**
 * The actions that are buttons, with their bit. The stick and C-stick directions are absent on
 * purpose: they are not buttons in the guest's button field, they push an axis (the upstream
 * `kActionPadBit` table has zeros for them, `host/input_bindings.h:64-67`).
 */
export const PAD_BUTTON_BITS: Readonly<Partial<Record<PadAction, number>>> = Object.freeze({
  A: PAD.A,
  B: PAD.B,
  X: PAD.X,
  Y: PAD.Y,
  Z: PAD.Z,
  Start: PAD.Start,
  L: PAD.L,
  R: PAD.R,
  DUp: PAD.Up,
  DDown: PAD.Down,
  DLeft: PAD.Left,
  DRight: PAD.Right,
});

/** The four actions that push the C-stick when bound to a button. */
export const C_STICK_ACTIONS: readonly PadAction[] = ['CUp', 'CDown', 'CLeft', 'CRight'];

/** The four actions that push the control stick when bound to a button. */
export const STICK_ACTIONS: readonly PadAction[] = ['SUp', 'SDown', 'SLeft', 'SRight'];

/** One controller port's state. Immutable: a source returns a new one per poll. */
export interface PadState {
  /** Bitwise OR of the `PAD` bits. */
  readonly button: number;
  readonly stickX: number;
  readonly stickY: number;
  readonly subX: number;
  readonly subY: number;
  readonly trigL: number;
  readonly trigR: number;
  readonly analogA: number;
  readonly analogB: number;
  /** 0 when a pad drives this port, -1 when nothing does. */
  readonly err: number;
}

/** Bytes of one guest `PADStatus`. */
export const PAD_STATUS_BYTES = 12;

/** Full deflection of an analog stick, in the state's own units. */
export const STICK_FULL = 127;

/**
 * The value a fully pressed analog trigger has, and the point above which the port reports the
 * digital L/R bit as well. Both are the upstream's: `x.trig_l = g.bLeftTrigger; if
 * (g.bLeftTrigger > 200) x.button |= PAD_L` (`host/window.cpp:980-981`). The value matters
 * because Melee shields from the analog value, not from the bit.
 */
export const TRIGGER_FULL = 255;
export const TRIGGER_CLICK = 200;

/** A port with nothing plugged into it. */
export function disconnectedPad(): PadState {
  return {
    button: 0,
    stickX: 0,
    stickY: 0,
    subX: 0,
    subY: 0,
    trigL: 0,
    trigR: 0,
    analogA: 0,
    analogB: 0,
    err: -1,
  };
}

/**
 * A port with a device on it. `err = 0` even when nothing is pressed: the upstream's keyboard
 * path always reports a present pad (`PadState kb{}; kb.err = 0;`, `host/window.cpp:930`), and
 * the guest only reads a port whose `err` is zero.
 */
export function neutralPad(): PadState {
  return { ...disconnectedPad(), err: 0 };
}

/** Clamp into the range one signed stick byte can hold. */
export function clampStick(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated > STICK_FULL) return STICK_FULL;
  if (truncated < -STICK_FULL) return -STICK_FULL;
  // `Math.trunc(-0.4)` is -0, which is a different value from 0 under Object.is and would make
  // two identical-looking states compare as different. The guest cannot tell them apart, but a
  // test can, so it is normalised here once.
  return truncated === 0 ? 0 : truncated;
}

/** Clamp into the range one trigger byte can hold. */
export function clampTrigger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded > TRIGGER_FULL) return TRIGGER_FULL;
  if (rounded < 0) return 0;
  return rounded;
}

/**
 * A circular deadzone, copied from the upstream's `apply_deadzone`
 * (`host/input_bindings.h:226-229`): inside the radius both axes are zeroed, outside it the
 * values are left alone. There is deliberately no rescaling — the upstream does not rescale
 * either, and a rescaled stick is a different stick for a game this sensitive.
 *
 * `radius` is in state units, and the panel's convention for a fraction is `/ 80`
 * (`gx/pc_settings.cpp:5731`): a deadzone setting of 0.25 is a radius of 20.
 */
export function applyDeadzone(
  x: number,
  y: number,
  radius: number,
): { x: number; y: number } {
  if (!(radius > 0)) return { x, y };
  if (x * x + y * y < radius * radius) return { x: 0, y: 0 };
  return { x, y };
}

/** State units for a deadzone expressed as a fraction of full deflection. */
export function deadzoneRadius(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.round(fraction * 80);
}

/**
 * Serialise one port's state into the guest's `PADStatus` layout.
 *
 * The button field is written big-endian because the guest is a PowerPC and the upstream's
 * `wr16` byteswaps before the store. Everything else is one byte, and the signed fields are
 * written as their two's complement byte, exactly like the `(uint8_t)` casts upstream.
 */
export function writePadStatus(pad: PadState, out: Uint8Array, offset = 0): void {
  if (out.length < offset + PAD_STATUS_BYTES) {
    throw new RangeError(`PADStatus needs ${PAD_STATUS_BYTES} bytes at offset ${offset}`);
  }
  const button = pad.button & 0xffff;
  out[offset + 0] = (button >>> 8) & 0xff;
  out[offset + 1] = button & 0xff;
  out[offset + 2] = pad.stickX & 0xff;
  out[offset + 3] = pad.stickY & 0xff;
  out[offset + 4] = pad.subX & 0xff;
  out[offset + 5] = pad.subY & 0xff;
  out[offset + 6] = clampTrigger(pad.trigL) & 0xff;
  out[offset + 7] = clampTrigger(pad.trigR) & 0xff;
  out[offset + 8] = pad.analogA & 0xff;
  out[offset + 9] = pad.analogB & 0xff;
  out[offset + 10] = pad.err & 0xff;
  out[offset + 11] = 0;
}

/** The same serialisation, as a fresh array. */
export function padStatusBytes(pad: PadState): Uint8Array {
  const out = new Uint8Array(PAD_STATUS_BYTES);
  writePadStatus(pad, out);
  return out;
}

/**
 * What the guest's `PADRead` returns: bit 31 set for port 1 when that port has a pad, shifted
 * right one bit per port (`hle_pad.cpp:70`). The game treats a port without the bit as
 * unplugged, so this is the difference between "no controller" and "controller at rest".
 */
export function freshDataMask(pads: readonly PadState[]): number {
  let mask = 0;
  for (let port = 0; port < 4; port += 1) {
    const pad = pads[port];
    if (pad && pad.err === 0) mask |= 0x80000000 >>> port;
  }
  return mask >>> 0;
}
