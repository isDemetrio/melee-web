import { describe, expect, it } from 'vitest';
import {
  GAMEPAD_AXIS,
  GAMEPAD_BUTTON,
  GamepadReader,
  convertAxis,
  defaultGamepadSource,
  isConnected,
  pickGamepad,
  readGamepad,
  type GamepadLike,
} from '../../src/input/gamepad.js';
import { PAD, TRIGGER_FULL } from '../../src/input/pad.js';

/** A standard-mapping pad, at rest unless a test says otherwise. */
function standardPad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  return {
    index: 0,
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    ...overrides,
  };
}

/** A pad with one button held, and one trigger at a given analog value. */
function withButton(index: number, overrides: Partial<GamepadLike> = {}): GamepadLike {
  const pad = standardPad(overrides);
  const buttons = [...(pad.buttons ?? [])];
  buttons[index] = { pressed: true, value: 1 };
  return { ...pad, buttons };
}

function withTrigger(index: number, value: number): GamepadLike {
  const pad = standardPad();
  const buttons = [...(pad.buttons ?? [])];
  buttons[index] = { pressed: value > 0.5, value };
  return { ...pad, buttons };
}

describe('standard gamepad button mapping', () => {
  it('maps the face buttons, Z on the right shoulder and Start on Menu', () => {
    // The port's XInput defaults: A/B/X/Y on the face buttons, Z on
    // XINPUT_GAMEPAD_RIGHT_SHOULDER, Start on XINPUT_GAMEPAD_START
    // (host/input_bindings.h:114-124). A standard pad numbers them 0-3, 5 and 9.
    const cases: Array<[number, number]> = [
      [GAMEPAD_BUTTON.A, PAD.A],
      [GAMEPAD_BUTTON.B, PAD.B],
      [GAMEPAD_BUTTON.X, PAD.X],
      [GAMEPAD_BUTTON.Y, PAD.Y],
      [GAMEPAD_BUTTON.RightShoulder, PAD.Z],
      [GAMEPAD_BUTTON.Start, PAD.Start],
    ];
    for (const [index, bit] of cases) {
      expect(readGamepad(withButton(index)).button, `button ${index}`).toBe(bit);
    }
  });

  it('maps the D-pad', () => {
    expect(readGamepad(withButton(GAMEPAD_BUTTON.DUp)).button).toBe(PAD.Up);
    expect(readGamepad(withButton(GAMEPAD_BUTTON.DDown)).button).toBe(PAD.Down);
    expect(readGamepad(withButton(GAMEPAD_BUTTON.DLeft)).button).toBe(PAD.Left);
    expect(readGamepad(withButton(GAMEPAD_BUTTON.DRight)).button).toBe(PAD.Right);
  });

  it('leaves the left shoulder unbound, as the port does', () => {
    // L is analog on this console; a shoulder that also set the L bit would make light
    // shield impossible. The upstream XInput table has no L/R entries for exactly this reason.
    expect(readGamepad(withButton(GAMEPAD_BUTTON.LeftShoulder)).button).toBe(0);
  });

  it('reads a pad that reports analog values but never sets pressed', () => {
    const pad = standardPad();
    const buttons = [...(pad.buttons ?? [])];
    buttons[GAMEPAD_BUTTON.A] = { value: 0.9 };
    expect(readGamepad({ ...pad, buttons }).button).toBe(PAD.A);
  });

  it('accepts a digital-only pad', () => {
    const pad = standardPad({
      buttons: [
        { pressed: true },
        { pressed: false },
        { pressed: false },
        { pressed: false },
        { pressed: false },
        { pressed: false },
        { pressed: true },
        { pressed: false },
      ],
    });
    expect(readGamepad(pad).button).toBe(PAD.A | PAD.L);
    expect(readGamepad(pad).trigL).toBe(TRIGGER_FULL);
  });
});

describe('analog triggers', () => {
  it('copies the analog value and sets the digital bit only above 200/255', () => {
    // window.cpp:980-981: trig_l = bLeftTrigger, and the L bit above 200. Melee shields from
    // the analog value, so the bit is an addition to it and not a replacement.
    const atThreshold = withTrigger(GAMEPAD_BUTTON.LeftTrigger, 200 / TRIGGER_FULL);
    expect(readGamepad(atThreshold).trigL).toBe(200);
    expect(readGamepad(atThreshold).button & PAD.L).toBe(0);

    const above = withTrigger(GAMEPAD_BUTTON.LeftTrigger, 0.79);
    expect(readGamepad(above).trigL).toBe(201);
    expect(readGamepad(above).button & PAD.L).toBe(PAD.L);
  });

  it('keeps the right trigger independent of the left', () => {
    const pad = withTrigger(GAMEPAD_BUTTON.RightTrigger, 1);
    expect(readGamepad(pad)).toMatchObject({ trigL: 0, trigR: 255 });
    expect(readGamepad(pad).button).toBe(PAD.R);
  });

  it('scales a full press to 255 and a half press to about half', () => {
    expect(readGamepad(withTrigger(GAMEPAD_BUTTON.LeftTrigger, 0.5)).trigL).toBe(128);
    expect(readGamepad(withTrigger(GAMEPAD_BUTTON.LeftTrigger, 0)).trigL).toBe(0);
  });
});

describe('stick conversion', () => {
  it('is the port’s own: truncate toward zero, clamped to ±127', () => {
    // host/window.cpp:971 divides the XInput short by 258 and truncates; the browser axis is
    // the same physical value in [-1, 1], so the equivalent is trunc(value * 127).
    expect(convertAxis(0)).toBe(0);
    expect(convertAxis(1)).toBe(127);
    expect(convertAxis(-1)).toBe(-127);
    expect(convertAxis(0.5)).toBe(63);
    expect(convertAxis(-0.5)).toBe(-63);
    expect(convertAxis(0.007)).toBe(0);
    expect(convertAxis(1.5)).toBe(127); // a pad that over-reports is clamped, not wrapped
    expect(convertAxis(-2)).toBe(-127);
    expect(convertAxis(Number.NaN)).toBe(0);
  });

  it('negates both Y axes, because the Gamepad API reports Y positive down', () => {
    // XInput's sThumbLY and sThumbRY are positive up, and the state is positive up. Reading
    // the browser value as-is inverts the controls.
    const up = standardPad({ axes: [0, -1, 0, -1] });
    expect(readGamepad(up)).toMatchObject({ stickX: 0, stickY: 127, subX: 0, subY: 127 });

    const down = standardPad({ axes: [0, 1, 0, 1] });
    expect(readGamepad(down)).toMatchObject({ stickX: 0, stickY: -127, subX: 0, subY: -127 });
  });

  it('does not negate the X axes', () => {
    const pad = standardPad({ axes: [1, 0, -1, 0] });
    expect(readGamepad(pad)).toMatchObject({ stickX: 127, subX: -127 });
  });

  it('puts the right stick on the C-stick and the left stick on the control stick', () => {
    const pad = standardPad({ axes: [0.5, 0, 0, -0.25] });
    expect(readGamepad(pad)).toMatchObject({ stickX: 63, stickY: 0, subX: 0, subY: 31 });
  });

  it('applies the deadzone to both sticks, after the conversion', () => {
    // 0.1 converts to 12 units, and 12² + 12² = 288 is inside a 20-unit radius, so both axes
    // are zeroed. The C-stick at 63 units is outside it and keeps its value.
    const pad = standardPad({ axes: [0.1, 0.1, 0.5, 0] });
    const state = readGamepad(pad, { deadzone: 0.25 });
    expect(state.stickX).toBe(0);
    expect(state.stickY).toBe(0);
    expect(state.subX).toBe(63);
    // The same pad without the setting keeps the value: the deadzone is a setting, not the map.
    expect(readGamepad(pad).stickX).toBe(12);
  });

  it('has no deadzone by default, matching the port and Dolphin', () => {
    // window.cpp:972-975: the Microsoft deadzone was removed because the game ignores a
    // resting stick and the recommended one swallowed real modifier positions.
    const pad = standardPad({ axes: [0.5, 0, 0, 0] });
    expect(readGamepad(pad).stickX).toBe(63);
  });

  it('survives a pad that reports fewer axes or buttons than a standard one', () => {
    const pad = standardPad({ axes: [], buttons: [] });
    expect(readGamepad(pad)).toMatchObject({ stickX: 0, stickY: 0, button: 0, err: 0 });
    const short = standardPad({ axes: [1] });
    expect(readGamepad(short)).toMatchObject({ stickX: 127, stickY: 0 });
  });
});

describe('no gamepad connected', () => {
  it('reports an unplugged port for null, undefined and a disconnected slot', () => {
    // getGamepads() keeps a slot for a device that was unplugged, with connected: false and its
    // last values frozen. Reading it would keep the character walking forever.
    for (const pad of [null, undefined, { connected: false, axes: [1, 1, 1, 1] }]) {
      const state = readGamepad(pad);
      expect(state.err).toBe(-1);
      expect(state.button).toBe(0);
      expect(state.stickX).toBe(0);
      expect(state.stickY).toBe(0);
      expect(state.subX).toBe(0);
      expect(state.subY).toBe(0);
      expect(state.trigL).toBe(0);
      expect(state.trigR).toBe(0);
    }
  });

  it('treats a pad with no connected flag as connected', () => {
    expect(isConnected({ axes: [] })).toBe(true);
    expect(isConnected({ connected: false })).toBe(false);
    expect(isConnected(null)).toBe(false);
  });

  it('polls an empty, null or throwing API as no pad, without throwing', () => {
    const cases: Array<{ getGamepads(): readonly (GamepadLike | null)[] | null }> = [
      { getGamepads: () => [] },
      { getGamepads: () => [null, null] },
      { getGamepads: () => null }, // allowed before a user gesture
      { getGamepads: () => [{ connected: false }] },
      {
        getGamepads: () => {
          throw new Error('permissions policy blocks gamepad');
        },
      },
    ];
    for (const source of cases) {
      const reader = new GamepadReader(source);
      expect(reader.read().err).toBe(-1);
      expect(reader.readPads()).toBeNull();
      expect(reader.available).toBe(true);
    }
  });

  it('reports the API as unavailable in Node, where navigator has no getGamepads', () => {
    expect(defaultGamepadSource()).toBeNull();
    const reader = new GamepadReader(null);
    expect(reader.available).toBe(false);
    expect(reader.read().err).toBe(-1);
  });

  it('reads the state of a connected pad through the reader', () => {
    const reader = new GamepadReader({ getGamepads: () => [withButton(GAMEPAD_BUTTON.B)] });
    expect(reader.read().button).toBe(PAD.B);
    expect(reader.readPads()?.mapping).toBe('standard');
  });
});

describe('picking a pad', () => {
  it('prefers a standard-mapped pad over one that does not declare the mapping', () => {
    // A non-standard pad's axis order is unknown, so it is a guess; the standard mapping wins
    // whenever it is available.
    const generic = { id: 'generic', connected: true, axes: [1, 0, 0, 0] };
    expect(pickGamepad([generic, standardPad()])?.mapping).toBe('standard');
    expect(pickGamepad([standardPad(), generic])?.mapping).toBe('standard');
  });

  it('falls back to a connected pad that does not declare the standard mapping', () => {
    const generic = { id: 'generic', connected: true, axes: [1, 0, 0, 0] };
    expect(pickGamepad([null, generic])).toBe(generic);
    expect(readGamepad(pickGamepad([null, generic])).stickX).toBe(127);
  });

  it('skips disconnected slots when choosing', () => {
    const dead = { connected: false, mapping: 'standard' };
    const alive = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0] };
    expect(pickGamepad([dead, alive])).toBe(alive);
    expect(pickGamepad([dead])).toBeNull();
    expect(pickGamepad([])).toBeNull();
  });

  it('uses the axis order the standard mapping defines, not the pad’s name', () => {
    // A DualShock through the standard mapping reports the left stick on axes 0/1 and the
    // right stick on 2/3, so the same code serves Xbox, PlayStation and Switch Pro pads.
    const playstation = standardPad({ id: 'Wireless Controller', axes: [0, -1, 1, 0] });
    expect(readGamepad(playstation)).toMatchObject({ stickY: 127, subX: 127 });
  });
});

describe('gamepad axis indices', () => {
  it('is the W3C standard layout', () => {
    expect(GAMEPAD_AXIS).toEqual({ LeftX: 0, LeftY: 1, RightX: 2, RightY: 3 });
    expect(GAMEPAD_BUTTON.A).toBe(0);
    expect(GAMEPAD_BUTTON.RightShoulder).toBe(5);
    expect(GAMEPAD_BUTTON.Start).toBe(9);
    expect(GAMEPAD_BUTTON.DUp).toBe(12);
  });
});
