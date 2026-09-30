/**
 * Keyboard → PAD state.
 *
 * The default bindings are the port's own defaults, translated from Windows virtual-key codes
 * to DOM `code` values. Source of truth:
 * `upstream/melee-unlocked/port/runtime/host/input_bindings.h:88-113` (`default_key_bindings`),
 * where A=Z, B=X, X=C, Y=V, Start=Enter, L=Q, R=W, Z=E, the D-pad on T/G/F/H, the C-stick on
 * I/K/J/L and the control stick on the arrow keys. The specification repeats the intent in
 * docs/SPEC_PIANO.md §1.4 ("Tastiera mappata come in melee-unlocked, frecce = stick, X = A,
 * Z = B" — the spec writes A/B the way the GameCube face buttons are labelled on a keyboard
 * layout, the port's own table is what is implemented).
 *
 * `event.code`, not `event.key`: a code is a physical key, so the mapping survives an AZERTY
 * or Dvorak layout, which is what a virtual-key code does on Windows as well. Binding to
 * `event.key` would move the buttons when the user changes keyboard layout mid-session.
 *
 * This module never touches `document`; the DOM wiring lives in `attachKeyboard` and takes the
 * event target as an argument, so the whole mapping is testable under Node.
 */

import {
  PAD,
  PAD_BUTTON_BITS,
  TRIGGER_FULL,
  neutralPad,
  type PadAction,
  type PadState,
} from './pad.js';

/**
 * The port's default keyboard bindings, keyed by DOM `code`.
 *
 * `Object.freeze` because a binding table that a caller can mutate in place is how two
 * players' mappings end up sharing state; a remap builds a new table.
 */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<PadAction, string>> = Object.freeze({
  A: 'KeyZ',
  B: 'KeyX',
  X: 'KeyC',
  Y: 'KeyV',
  Z: 'KeyE',
  Start: 'Enter',
  L: 'KeyQ',
  R: 'KeyW',
  DUp: 'KeyT',
  DDown: 'KeyG',
  DLeft: 'KeyF',
  DRight: 'KeyH',
  CUp: 'KeyI',
  CDown: 'KeyK',
  CLeft: 'KeyJ',
  CRight: 'KeyL',
  SUp: 'ArrowUp',
  SDown: 'ArrowDown',
  SLeft: 'ArrowLeft',
  SRight: 'ArrowRight',
});

export type KeyBindings = Readonly<Record<PadAction, string>>;

/** The part of a DOM keyboard event this module needs. */
export interface KeyEventLike {
  readonly code: string;
  /** The element the event was dispatched to, used to ignore typing in a form field. */
  readonly target?: unknown;
  preventDefault?: () => void;
}

/**
 * True when a key event belongs to a text field rather than to the game.
 *
 * The upstream reads the keyboard only while the game window has focus, so typing in another
 * window cannot play the game. A browser page cannot be that selective, and this shell has a
 * nickname field on the boot and lobby screens: without this check, typing a name would press
 * GameCube buttons. `code` alone cannot tell the difference, so the target is inspected.
 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  if (typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The keyboard as one input source.
 *
 * Held keys are a set, not a per-frame sample: a key that went down and up between two
 * simulation frames must not be lost, and a key held across frames must stay down. The
 * simulation polls `read()` once per tick, and the DOM events arrive whenever they arrive.
 */
export class KeyboardSource {
  private readonly held = new Set<string>();

  constructor(private readonly bindings: KeyBindings = DEFAULT_KEY_BINDINGS) {}

  /** The key bound to one action, or '' when the action is unbound. */
  bindingFor(action: PadAction): string {
    return this.bindings[action] ?? '';
  }

  /** True when any action is bound to this physical key. */
  isBound(code: string): boolean {
    for (const action of Object.keys(this.bindings) as PadAction[]) {
      if (this.bindings[action] === code) return true;
    }
    return false;
  }

  /** Returns false when the event was ignored, so a caller knows not to preventDefault. */
  handleKeyDown(event: KeyEventLike): boolean {
    if (isEditableTarget(event.target)) return false;
    if (!this.isBound(event.code)) return false;
    this.held.add(event.code);
    return true;
  }

  handleKeyUp(event: KeyEventLike): boolean {
    if (isEditableTarget(event.target)) return false;
    if (!this.held.has(event.code)) return false;
    this.held.delete(event.code);
    return true;
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  /** Drop every held key. Called on window blur: a key released in another window never
   * arrives, and a stuck direction would keep walking the character. */
  releaseAll(): void {
    this.held.clear();
  }

  /**
   * The state this source produces for one tick.
   *
   * The shape of the computation is the upstream's `apply_actions` + `apply_stick_actions` +
   * `apply_cstick_actions` (`host/window.cpp:953-956`, `host/input_bindings.h:69-90`):
   *  - buttons come from the binding table, bit by bit;
   *  - a bound stick direction pushes that axis fully, and only when the two opposite
   *    directions disagree — with both Up and Down held the upstream leaves the axis alone,
   *    which is why the neutral value survives instead of becoming a full push;
   *  - the analog triggers are digital on a keyboard, so L and R bottom them out at 255. The
   *    game shields from the analog value, so a keyboard L that only set the bit would never
   *    shield at all.
   *
   * `err` is 0: the upstream's keyboard state is always a present pad, and the guest ignores a
   * port whose `err` is not zero.
   */
  read(): PadState {
    let button = 0;
    const down = (action: PadAction): boolean => {
      const code = this.bindings[action];
      return code !== undefined && code !== '' && this.held.has(code);
    };

    for (const action of Object.keys(this.bindings) as PadAction[]) {
      if (!down(action)) continue;
      const bit = PAD_BUTTON_BITS[action];
      if (bit !== undefined) button |= bit;
    }

    let stickX = 0;
    let stickY = 0;
    const up = down('SUp');
    const downDir = down('SDown');
    const left = down('SLeft');
    const right = down('SRight');
    if (up !== downDir) stickY = up ? 127 : -127;
    if (left !== right) stickX = right ? 127 : -127;

    let subX = 0;
    let subY = 0;
    const cUp = down('CUp');
    const cDown = down('CDown');
    const cLeft = down('CLeft');
    const cRight = down('CRight');
    if (cUp !== cDown) subY = cUp ? 127 : -127;
    if (cLeft !== cRight) subX = cRight ? 127 : -127;

    return {
      ...neutralPad(),
      button,
      stickX,
      stickY,
      subX,
      subY,
      trigL: button & PAD.L ? TRIGGER_FULL : 0,
      trigR: button & PAD.R ? TRIGGER_FULL : 0,
    };
  }
}

/** The subset of `EventTarget` the wiring needs, so tests can pass a recorder. */
export interface KeyboardTarget {
  addEventListener(type: string, listener: (event: KeyEventLike) => void): void;
  removeEventListener(type: string, listener: (event: KeyEventLike) => void): void;
}

/**
 * Wire a source to a real event target (the window).
 *
 * Bound keys have their default action suppressed: arrow keys scroll the page and Enter
 * submits forms, and a game that scrolls while the player walks is not playable. Unbound keys
 * are left alone so browser shortcuts and typing still work.
 *
 * Returns the detach function; calling it removes every listener this call added.
 */
export function attachKeyboard(target: KeyboardTarget, source: KeyboardSource): () => void {
  const onKeyDown = (event: KeyEventLike): void => {
    if (source.handleKeyDown(event)) event.preventDefault?.();
  };
  const onKeyUp = (event: KeyEventLike): void => {
    if (source.handleKeyUp(event)) event.preventDefault?.();
  };
  const onBlur = (): void => source.releaseAll();

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur as unknown as (event: KeyEventLike) => void);

  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', onBlur as unknown as (event: KeyEventLike) => void);
    source.releaseAll();
  };
}
