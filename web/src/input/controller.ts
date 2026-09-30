/**
 * The input layer's front door: one poll, one PAD state.
 *
 * The rule for combining a keyboard and a pad is the port's, not a preference invented here.
 * Upstream, each in-game port has a source; the keyboard is the default one, and
 * `keyboard_and_pad` (`upstream/melee-unlocked/port/runtime/host/window.cpp:1049-1070`) reads:
 *
 *     PadState result = kb;
 *     ...find the first pad that no other port has taken...
 *     // With a controller connected, the default port is that controller alone: keys pressed
 *     // while playing on a pad (hotkeys, typing) must not press game buttons.
 *     if (pad) result = *pad;
 *     return result;
 *
 * So this is a replacement, not a bitwise merge: with a pad connected the pad wins outright,
 * and the keyboard drives the port only when no pad is. Merging the two would let a key held
 * down press a button while the player is on a controller, which is the exact bug that comment
 * upstream was written to fix.
 *
 * The poll is per simulation tick: `poll()` is called once per tick by whatever owns the loop,
 * and it never blocks or awaits. Today nothing owns a loop — there is no simulation, so nothing
 * imports this module yet and it is exercised by its unit tests alone. Wiring it to the worker
 * that will drive the WASM core is the next step for this layer, and it is recorded in
 * docs/PROGRESS.md rather than implied here.
 */

import { PAD_STATUS_BYTES, padStatusBytes, type PadState } from './pad.js';
import { KeyboardSource, attachKeyboard, type KeyboardTarget, type KeyBindings } from './keyboard.js';
import { GamepadReader } from './gamepad.js';

export interface InputOptions {
  /** Override the keyboard bindings (a remap). Defaults to the port's own defaults. */
  readonly bindings?: KeyBindings;
  /**
   * Deadzone for the analog sticks, as a fraction of full deflection — the same units as
   * `Settings.controlStickDeadzone` (`web/src/ui/settings.ts`), so the settings screen can pass
   * its value straight through. 0 disables it, which is what the port does by default.
   */
  readonly deadzone?: number;
}

/**
 * Which device drove the last poll. The settings screen shows this, and a test asserts on it
 * instead of inferring the source from the shape of the state.
 */
export type InputSource = 'keyboard' | 'gamepad' | 'none';

export class InputController {
  readonly keyboard: KeyboardSource;
  readonly gamepads: GamepadReader;

  private lastSource: InputSource = 'none';
  private detachKeyboardWiring: (() => void) | null = null;
  private keyboardDetached = false;

  constructor(
    private readonly options: InputOptions = {},
    gamepads?: GamepadReader,
  ) {
    this.keyboard = new KeyboardSource(options.bindings);
    this.gamepads = gamepads ?? new GamepadReader(undefined, options);
  }

  /** Bytes of one PADStatus, for a caller sizing a buffer. */
  static get statusBytes(): number {
    return PAD_STATUS_BYTES;
  }

  get source(): InputSource {
    return this.lastSource;
  }

  /** True while the keyboard is not being read (never attached, or detached). */
  get isKeyboardDetached(): boolean {
    return this.keyboardDetached;
  }

  /**
   * One tick's state for the local player's port.
   *
   * With a pad connected the pad's state is returned whole. Otherwise the keyboard's is, and
   * that state always reports a present pad (`err: 0`), because upstream's keyboard state does
   * (`PadState kb{}; kb.err = 0;`). `err: -1` therefore means "this player has no input device
   * that produces a port" — a phone with no controller and the keyboard detached — which is a
   * real state and has to reach the guest as an empty port, not as a pad at rest.
   */
  poll(): PadState {
    const pad = this.gamepads.read(this.options);
    if (pad.err === 0) {
      this.lastSource = 'gamepad';
      return pad;
    }
    if (this.keyboardDetached) {
      this.lastSource = 'none';
      return pad;
    }
    this.lastSource = 'keyboard';
    return this.keyboard.read();
  }

  /** The same state, serialised as the guest's 12-byte PADStatus. */
  pollStatus(): Uint8Array {
    return padStatusBytes(this.poll());
  }

  /**
   * Wire the keyboard to an event target (the window) and start accepting keys. Returns a
   * detach function; the gamepad side needs no wiring, it is polled.
   */
  attach(target: KeyboardTarget): () => void {
    this.detachKeyboardWiring?.();
    this.keyboardDetached = false;
    const detach = attachKeyboard(target, this.keyboard);
    this.detachKeyboardWiring = () => {
      detach();
      this.detachKeyboardWiring = null;
      this.keyboardDetached = true;
    };
    return this.detachKeyboardWiring;
  }

  /** Stop reading the keyboard and drop every held key. Safe to call twice. */
  detachKeyboard(): void {
    if (this.detachKeyboardWiring) {
      this.detachKeyboardWiring();
      return;
    }
    this.keyboard.releaseAll();
    this.keyboardDetached = true;
  }
}
