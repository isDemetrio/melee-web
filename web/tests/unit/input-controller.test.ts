import { describe, expect, it } from 'vitest';
import { InputController } from '../../src/input/controller.js';
import { GamepadReader, type GamepadLike } from '../../src/input/gamepad.js';
import { PAD, PAD_STATUS_BYTES, padStatusBytes } from '../../src/input/pad.js';
import { DEFAULT_KEY_BINDINGS, type KeyEventLike } from '../../src/input/keyboard.js';

/** A reader that reports exactly the pad a test hands it, or nothing at all. */
function readerFor(pads: readonly (GamepadLike | null)[]): GamepadReader {
  return new GamepadReader({ getGamepads: () => pads });
}

const NO_GAMEPADS = new GamepadReader({ getGamepads: () => [] });

function padWithButton(bit: number): GamepadLike {
  return {
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: [
      { pressed: Boolean(bit & PAD.A) },
      { pressed: Boolean(bit & PAD.B) },
      { pressed: Boolean(bit & PAD.X) },
      { pressed: Boolean(bit & PAD.Y) },
      { pressed: false },
      { pressed: Boolean(bit & PAD.Z) },
      { pressed: false },
      { pressed: false },
      { pressed: false },
      { pressed: Boolean(bit & PAD.Start) },
    ],
  };
}

describe('InputController', () => {
  it('lets the keyboard drive the port when no pad is connected', () => {
    const input = new InputController({}, NO_GAMEPADS);
    input.keyboard.handleKeyDown({ code: 'KeyZ' });
    const state = input.poll();
    expect(input.source).toBe('keyboard');
    expect(state.button).toBe(PAD.A);
    expect(state.err).toBe(0);
  });

  it('replaces the keyboard with the pad once one is connected, as the port does', () => {
    // window.cpp:1063-1068: "With a controller connected, the default port is that controller
    // alone: keys pressed while playing on a pad must not press game buttons." A key held down
    // when the pad appears must not keep pressing its button.
    const input = new InputController({}, readerFor([padWithButton(PAD.B)]));
    input.keyboard.handleKeyDown({ code: 'KeyZ' }); // A, on the keyboard
    const state = input.poll();
    expect(input.source).toBe('gamepad');
    expect(state.button).toBe(PAD.B);
  });

  it('falls back to the keyboard again when the pad goes away', () => {
    let pads: readonly (GamepadLike | null)[] = [padWithButton(PAD.B)];
    const input = new InputController({}, new GamepadReader({ getGamepads: () => pads }));
    expect(input.poll().button).toBe(PAD.B);
    // An unplugged pad keeps its slot with connected: false and frozen values.
    pads = [{ ...padWithButton(PAD.B), connected: false }];
    input.keyboard.handleKeyDown({ code: 'KeyZ' });
    expect(input.source).toBe('keyboard');
    expect(input.poll().button).toBe(PAD.A);
  });

  it('reports no input device as an unplugged port, not as a pad at rest', () => {
    // A phone with no controller and the keyboard detached. err = -1 is what tells the guest
    // the port is empty; a neutral state with err = 0 would look like a pad nobody is holding.
    const input = new InputController({}, NO_GAMEPADS);
    input.detachKeyboard();
    const state = input.poll();
    expect(input.source).toBe('none');
    expect(state.err).toBe(-1);
    expect(state.button).toBe(0);
  });

  it('serialises the polled state as one PADStatus', () => {
    const input = new InputController({}, NO_GAMEPADS);
    input.keyboard.handleKeyDown({ code: 'ArrowUp' });
    input.keyboard.handleKeyDown({ code: 'KeyQ' });
    const bytes = input.pollStatus();
    expect(bytes.length).toBe(PAD_STATUS_BYTES);
    expect([...bytes]).toEqual([...padStatusBytes(input.poll())]);
    expect(bytes[0]).toBe(0x00); // no buttons except L
    expect(bytes[1]).toBe(0x40); // L, low byte
    expect(bytes[3]).toBe(0x7f); // stick_y up
  });

  it('applies the deadzone setting to a pad and never to the keyboard', () => {
    // The keyboard pushes the stick to its bound value directly (apply_stick_actions), so a
    // deadzone meant for a physical stick's drift must not eat it.
    const pad: GamepadLike = { ...padWithButton(0), axes: [0.1, 0.1, 0, 0] };
    const input = new InputController({ deadzone: 0.25 }, readerFor([pad]));
    expect(input.poll().stickX).toBe(0);

    const keyboard = new InputController({ deadzone: 0.25 }, NO_GAMEPADS);
    keyboard.keyboard.handleKeyDown({ code: 'ArrowRight' });
    expect(keyboard.poll().stickX).toBe(127);
  });

  it('accepts a remapped keyboard and passes it through', () => {
    const input = new InputController(
      { bindings: { ...DEFAULT_KEY_BINDINGS, A: 'Space' } },
      NO_GAMEPADS,
    );
    input.keyboard.handleKeyDown({ code: 'Space' });
    expect(input.poll().button).toBe(PAD.A);
    // The old default for A is now unbound.
    input.keyboard.releaseAll();
    input.keyboard.handleKeyDown({ code: 'KeyZ' });
    expect(input.poll().button).toBe(0);
  });

  it('attaches and detaches the keyboard wiring', () => {
    const listeners = new Map<string, Set<(event: KeyEventLike) => void>>();
    const target = {
      addEventListener(type: string, listener: (event: KeyEventLike) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: (event: KeyEventLike) => void) {
        listeners.get(type)?.delete(listener);
      },
    };
    const input = new InputController({}, NO_GAMEPADS);
    expect(input.isKeyboardDetached).toBe(false);

    const detach = input.attach(target);
    expect(input.isKeyboardDetached).toBe(false);
    for (const listener of [...(listeners.get('keydown') ?? [])]) listener({ code: 'KeyZ' });
    expect(input.poll().button).toBe(PAD.A);

    detach();
    expect(input.isKeyboardDetached).toBe(true);
    expect(input.poll().err).toBe(-1);
    for (const set of listeners.values()) expect(set.size).toBe(0);
  });

  it('survives being detached twice', () => {
    const input = new InputController({}, NO_GAMEPADS);
    input.detachKeyboard();
    input.detachKeyboard();
    expect(input.isKeyboardDetached).toBe(true);
    expect(input.poll().err).toBe(-1);
  });
});
