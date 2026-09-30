/**
 * Gamepad API → PAD state.
 *
 * docs/SPEC_PIANO.md §2.2 asks for exactly this: poll the Gamepad API once per simulation
 * frame, map a "standard gamepad" (Xbox, PlayStation, Switch Pro) with the left stick on the
 * control stick, the right stick on the C-stick and the analog triggers on the analog L/R with
 * a threshold for the digital click. The defaults below mirror the port's XInput defaults
 * (`upstream/melee-unlocked/port/runtime/host/input_bindings.h:114-124` and
 * `host/window.cpp:966-982`), because the native build is the reference: A/B/X/Y on the face
 * buttons, Z on the right shoulder, Start on Menu, the D-pad on the D-pad, L/R on the triggers.
 * The left shoulder is deliberately left unbound, as upstream: L and R are analog on this
 * console and a shoulder button that also set the L bit would make light shield impossible.
 *
 * Three things here are traps, and each has a test:
 *
 *  1. The Gamepad API reports its Y axes positive DOWN. The port's `stick_y` is positive UP
 *     (XInput's `sThumbLY` is), so both Y axes are negated. Getting this wrong inverts the
 *     controls and looks like a deadzone bug.
 *  2. The axis conversion is the port's: XInput's short is divided by 258 and truncated
 *     (`auto axis = [](SHORT v) { int a = v / 258; ... }`, `host/window.cpp:971`). The browser
 *     hands us the same physical axis as a float in [-1, 1] with no access to the short, so the
 *     equivalent is `trunc(value * 127)` — the same truncation, toward zero, and the same
 *     ±127 clamp. The two agree to within the browser's own quantisation of the axis, which is
 *     not observable: the result is one byte either way.
 *  3. `navigator.getGamepads()` returns a slot per remembered device, with `connected: false`
 *     for one that has been unplugged, and may return null or throw. All three cases must
 *     produce "no pad", not a neutral pad and not an exception.
 *
 * No DOM and no `navigator` here either: the reader takes its `getGamepads` as an argument.
 */

import {
  PAD,
  TRIGGER_CLICK,
  TRIGGER_FULL,
  applyDeadzone,
  clampStick,
  clampTrigger,
  deadzoneRadius,
  disconnectedPad,
  type PadState,
} from './pad.js';

/** Standard-mapping button indices, as the W3C Gamepad spec numbers them. */
export const GAMEPAD_BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LeftShoulder: 4,
  RightShoulder: 5,
  LeftTrigger: 6,
  RightTrigger: 7,
  Select: 8,
  Start: 9,
  DUp: 12,
  DDown: 13,
  DLeft: 14,
  DRight: 15,
} as const;

/** Standard-mapping axis indices. */
export const GAMEPAD_AXIS = { LeftX: 0, LeftY: 1, RightX: 2, RightY: 3 } as const;

/**
 * The part of a `Gamepad` this module reads. Structural on purpose: the unit tests use plain
 * objects, and a browser `Gamepad` satisfies it without a cast.
 */
export interface GamepadLike {
  readonly index?: number;
  readonly id?: string;
  readonly connected?: boolean;
  readonly mapping?: string;
  readonly axes?: readonly number[];
  readonly buttons?: readonly GamepadButtonLike[];
}

export interface GamepadButtonLike {
  readonly pressed?: boolean;
  readonly value?: number;
}

export interface GamepadReadOptions {
  /** Deadzone as a fraction of full deflection; 0 disables it. */
  readonly deadzone?: number;
}

/**
 * One axis of one pad, as the state's own units.
 *
 * Exported because the conversion is the one number the port's parity depends on, and a test
 * that pins it is worth more than a comment.
 */
export function convertAxis(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampStick(value * 127);
}

function axisAt(pad: GamepadLike, index: number): number {
  const value = pad.axes?.[index];
  return typeof value === 'number' ? value : 0;
}

/**
 * Negates one axis value, for the two Y axes. Written as a function rather than a unary minus
 * so that a zero stays +0: `-0` is a different value from `0` under `Object.is`, and a state
 * that is neutral in every field should be one value, not two.
 */
function invert(value: number): number {
  return value === 0 ? 0 : -value;
}

function buttonAt(pad: GamepadLike, index: number): GamepadButtonLike | undefined {
  return pad.buttons?.[index];
}

function isPressed(pad: GamepadLike, index: number): boolean {
  const button = buttonAt(pad, index);
  if (!button) return false;
  // Some pads report an analog value and never set `pressed`; either one is a press.
  return button.pressed === true || (button.value ?? 0) > 0.5;
}

/** One trigger, 0..255, from a Gamepad button's analog value. */
function triggerValue(pad: GamepadLike, index: number): number {
  const button = buttonAt(pad, index);
  if (!button) return 0;
  const value = typeof button.value === 'number' && Number.isFinite(button.value)
    ? button.value
    : button.pressed === true
      ? 1
      : 0;
  return clampTrigger(value * TRIGGER_FULL);
}

/**
 * A pad is usable when the browser says it is connected. A `Gamepad` object stays in the
 * array after the device is unplugged, with `connected: false` and its last values frozen —
 * reading it would keep the character walking into a wall forever.
 */
export function isConnected(pad: GamepadLike | null | undefined): pad is GamepadLike {
  return !!pad && pad.connected !== false;
}

/**
 * The pad a single local player uses: the first one that declares the standard mapping, or the
 * first connected one when none does.
 *
 * A non-standard pad is read with the standard layout anyway. Its axis order is unknown, so
 * this is a guess — but the upstream makes the same guess for generic HID pads
 * (`default_hid_bindings`, "a starting point rather than a correct mapping") and a guess that
 * sometimes works beats a pad that is silently ignored. What matters is that the standard
 * mapping wins whenever it is available, and that is what the test pins.
 */
export function pickGamepad(pads: readonly (GamepadLike | null)[]): GamepadLike | null {
  let fallback: GamepadLike | null = null;
  for (const pad of pads) {
    if (!isConnected(pad)) continue;
    if (pad.mapping === 'standard') return pad;
    if (!fallback) fallback = pad;
  }
  return fallback;
}

/** One pad's state. A pad that is not connected produces an unplugged port. */
export function readGamepad(
  pad: GamepadLike | null | undefined,
  options: GamepadReadOptions = {},
): PadState {
  if (!isConnected(pad)) return disconnectedPad();

  let button = 0;
  if (isPressed(pad, GAMEPAD_BUTTON.A)) button |= PAD.A;
  if (isPressed(pad, GAMEPAD_BUTTON.B)) button |= PAD.B;
  if (isPressed(pad, GAMEPAD_BUTTON.X)) button |= PAD.X;
  if (isPressed(pad, GAMEPAD_BUTTON.Y)) button |= PAD.Y;
  if (isPressed(pad, GAMEPAD_BUTTON.RightShoulder)) button |= PAD.Z;
  if (isPressed(pad, GAMEPAD_BUTTON.Start)) button |= PAD.Start;
  if (isPressed(pad, GAMEPAD_BUTTON.DUp)) button |= PAD.Up;
  if (isPressed(pad, GAMEPAD_BUTTON.DDown)) button |= PAD.Down;
  if (isPressed(pad, GAMEPAD_BUTTON.DLeft)) button |= PAD.Left;
  if (isPressed(pad, GAMEPAD_BUTTON.DRight)) button |= PAD.Right;

  const trigL = triggerValue(pad, GAMEPAD_BUTTON.LeftTrigger);
  const trigR = triggerValue(pad, GAMEPAD_BUTTON.RightTrigger);
  // Melee shields from the analog value, so the digital bit is an addition to it, never a
  // replacement: the upstream sets both (`window.cpp:980-981`).
  if (trigL > TRIGGER_CLICK) button |= PAD.L;
  if (trigR > TRIGGER_CLICK) button |= PAD.R;

  const radius = deadzoneRadius(options.deadzone ?? 0);
  // The Y axes are inverted here, and only here: see the header comment.
  const stick = applyDeadzone(
    convertAxis(axisAt(pad, GAMEPAD_AXIS.LeftX)),
    invert(convertAxis(axisAt(pad, GAMEPAD_AXIS.LeftY))),
    radius,
  );
  const cStick = applyDeadzone(
    convertAxis(axisAt(pad, GAMEPAD_AXIS.RightX)),
    invert(convertAxis(axisAt(pad, GAMEPAD_AXIS.RightY))),
    radius,
  );

  return {
    button,
    stickX: stick.x,
    stickY: stick.y,
    subX: cStick.x,
    subY: cStick.y,
    trigL,
    trigR,
    analogA: 0,
    analogB: 0,
    // A connected pad is a present port, whatever is pressed on it.
    err: 0,
  };
}

/** What the reader needs from `navigator`, so a test can supply its own. */
export interface GamepadSource {
  getGamepads(): readonly (GamepadLike | null)[] | null;
}

/** `navigator` when it has `getGamepads`, otherwise null. */
export function defaultGamepadSource(): GamepadSource | null {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  if (!nav || !('getGamepads' in nav)) return null;
  return { getGamepads: () => nav.getGamepads() };
}

/**
 * Polls the Gamepad API for the local player.
 *
 * Polling is per simulation frame, not per `requestAnimationFrame` (docs/SPEC_PIANO.md §2.2):
 * the simulation may run at a different rate from the display, and a state sampled at the
 * display rate would drop or repeat presses.
 *
 * Every failure mode of the API ends in the same place — an unplugged port:
 *  - no `navigator.getGamepads` (the capability report already flags this, capabilities.ts);
 *  - `getGamepads()` returning null, which it is allowed to do before a user gesture;
 *  - `getGamepads()` throwing, which a permissions policy can cause in an iframe;
 *  - a slot holding `null`, or a pad whose `connected` is false.
 *
 * A player on a keyboard therefore never sees this module's output at all (see controller.ts),
 * and a player with no input device at all gets `err: -1`, which is exactly what the guest
 * needs to know that the port is empty.
 */
export class GamepadReader {
  constructor(
    private readonly source: GamepadSource | null = defaultGamepadSource(),
    private readonly options: GamepadReadOptions = {},
  ) {}

  /** True when the API exists at all; false is not an error. */
  get available(): boolean {
    return this.source !== null;
  }

  /**
   * The picked pad's state. `options` overrides the reader's own, so an injected reader and the
   * one the controller builds itself behave identically.
   */
  read(options: GamepadReadOptions = this.options): PadState {
    return readGamepad(this.readPads(), options);
  }

  /** The pad this reader picked, or null. Exposed for the settings screen and for tests. */
  readPads(): GamepadLike | null {
    if (!this.source) return null;
    let pads: readonly (GamepadLike | null)[] | null;
    try {
      pads = this.source.getGamepads();
    } catch {
      return null;
    }
    if (!pads) return null;
    return pickGamepad(pads);
  }
}
