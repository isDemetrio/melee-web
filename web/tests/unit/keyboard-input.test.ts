import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEY_BINDINGS,
  KeyboardSource,
  attachKeyboard,
  isEditableTarget,
  type KeyEventLike,
} from '../../src/input/keyboard.js';
import { PAD, TRIGGER_FULL } from '../../src/input/pad.js';

describe('default keyboard bindings', () => {
  it('is the port’s own table, translated from virtual keys to DOM codes', () => {
    // host/input_bindings.h:88-113, default_key_bindings, read as event.code values.
    expect(DEFAULT_KEY_BINDINGS).toEqual({
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
  });

  it('cannot be mutated in place', () => {
    expect(Object.isFrozen(DEFAULT_KEY_BINDINGS)).toBe(true);
  });
});

describe('KeyboardSource', () => {
  it('starts at a present, neutral pad', () => {
    const source = new KeyboardSource();
    const pad = source.read();
    expect(pad.err).toBe(0);
    expect(pad.button).toBe(0);
    expect(pad.stickX).toBe(0);
    expect(pad.trigL).toBe(0);
  });

  it('sets exactly the bound button bit while a key is held, and clears it on release', () => {
    const source = new KeyboardSource();
    source.handleKeyDown({ code: 'KeyZ' }); // A
    expect(source.read().button).toBe(PAD.A);

    source.handleKeyDown({ code: 'KeyX' }); // B
    expect(source.read().button).toBe(PAD.A | PAD.B);

    source.handleKeyUp({ code: 'KeyZ' });
    expect(source.read().button).toBe(PAD.B);

    source.handleKeyUp({ code: 'KeyX' });
    expect(source.read().button).toBe(0);
  });

  it('maps every face button, shoulder, start and the D-pad', () => {
    const cases: Array<[string, number]> = [
      ['KeyZ', PAD.A],
      ['KeyX', PAD.B],
      ['KeyC', PAD.X],
      ['KeyV', PAD.Y],
      ['KeyE', PAD.Z],
      ['Enter', PAD.Start],
      ['KeyT', PAD.Up],
      ['KeyG', PAD.Down],
      ['KeyF', PAD.Left],
      ['KeyH', PAD.Right],
    ];
    for (const [code, bit] of cases) {
      const source = new KeyboardSource();
      source.handleKeyDown({ code });
      expect(source.read().button, code).toBe(bit);
    }
  });

  it('keeps a key held across two polls, so a press is never lost between ticks', () => {
    const source = new KeyboardSource();
    source.handleKeyDown({ code: 'KeyZ' });
    expect(source.read().button).toBe(PAD.A);
    expect(source.read().button).toBe(PAD.A);
  });

  it('pushes the control stick fully with the arrow keys', () => {
    const source = new KeyboardSource();
    source.handleKeyDown({ code: 'ArrowUp' });
    expect(source.read()).toMatchObject({ stickX: 0, stickY: 127 });

    source.handleKeyDown({ code: 'ArrowLeft' });
    expect(source.read()).toMatchObject({ stickX: -127, stickY: 127 });

    source.handleKeyUp({ code: 'ArrowUp' });
    expect(source.read()).toMatchObject({ stickX: -127, stickY: 0 });
  });

  it('leaves an axis alone when both opposite directions are held', () => {
    // apply_stick_actions: the axis moves only when up !== down, so Up+Down is neutral and
    // Left is still applied on its own axis (host/input_bindings.h:83-90).
    const source = new KeyboardSource();
    source.handleKeyDown({ code: 'ArrowUp' });
    source.handleKeyDown({ code: 'ArrowDown' });
    source.handleKeyDown({ code: 'ArrowLeft' });
    expect(source.read()).toMatchObject({ stickX: -127, stickY: 0 });
  });

  it('pushes the C-stick with I/K/J/L and does not touch the button field', () => {
    const source = new KeyboardSource();
    source.handleKeyDown({ code: 'KeyI' });
    expect(source.read()).toMatchObject({ subX: 0, subY: 127, button: 0 });

    source.handleKeyDown({ code: 'KeyJ' });
    source.handleKeyUp({ code: 'KeyI' });
    expect(source.read()).toMatchObject({ subX: -127, subY: 0, button: 0 });
  });

  it('bottoms the analog triggers out on L and R, because Melee shields from the analog value', () => {
    const source = new KeyboardSource();
    source.handleKeyDown({ code: 'KeyQ' });
    expect(source.read()).toMatchObject({ trigL: TRIGGER_FULL, trigR: 0, button: PAD.L });

    source.handleKeyDown({ code: 'KeyW' });
    expect(source.read()).toMatchObject({ trigL: TRIGGER_FULL, trigR: TRIGGER_FULL });
    expect(source.read().button).toBe(PAD.L | PAD.R);

    source.handleKeyUp({ code: 'KeyQ' });
    source.handleKeyUp({ code: 'KeyW' });
    expect(source.read()).toMatchObject({ trigL: 0, trigR: 0, button: 0 });
  });

  it('ignores a key that is not bound', () => {
    const source = new KeyboardSource();
    expect(source.handleKeyDown({ code: 'KeyP' })).toBe(false);
    expect(source.handleKeyUp({ code: 'KeyP' })).toBe(false);
    expect(source.read().button).toBe(0);
  });

  it('ignores typing in a text field, which this shell has on the boot and lobby screens', () => {
    const source = new KeyboardSource();
    // 'KeyZ' is A. A nickname field must not press GameCube buttons while the player types.
    const input = { tagName: 'INPUT' };
    expect(source.handleKeyDown({ code: 'KeyZ', target: input })).toBe(false);
    expect(source.read().button).toBe(0);
    // The same key on the page body is a press.
    expect(source.handleKeyDown({ code: 'KeyZ', target: { tagName: 'BODY' } })).toBe(true);
    expect(source.read().button).toBe(PAD.A);
    expect(source.handleKeyUp({ code: 'KeyZ', target: input })).toBe(false);
    expect(source.read().button).toBe(PAD.A);
  });

  it('recognises the editable elements', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'BODY' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget('INPUT')).toBe(false); // a string is not an element
  });

  it('drops every held key on releaseAll, so a key released elsewhere cannot stick', () => {
    const source = new KeyboardSource();
    source.handleKeyDown({ code: 'ArrowRight' });
    source.handleKeyDown({ code: 'KeyZ' });
    source.releaseAll();
    expect(source.read()).toMatchObject({ button: 0, stickX: 0 });
    expect(source.isHeld('ArrowRight')).toBe(false);
  });

  it('accepts a remapped table and reports the binding it uses', () => {
    const source = new KeyboardSource({ ...DEFAULT_KEY_BINDINGS, A: 'Space', SUp: 'KeyW' });
    expect(source.bindingFor('A')).toBe('Space');
    expect(source.isBound('Space')).toBe(true);
    source.handleKeyDown({ code: 'Space' });
    expect(source.read().button).toBe(PAD.A);
    source.handleKeyDown({ code: 'KeyW' });
    expect(source.read().stickY).toBe(127);
  });
});

/** Records the listeners a target receives, so the wiring can be driven from a test. */
function fakeTarget(): {
  target: { addEventListener(type: string, listener: (event: KeyEventLike) => void): void; removeEventListener(type: string, listener: (event: KeyEventLike) => void): void };
  emit(type: string, event: KeyEventLike): void;
  listeners: Map<string, Set<(event: KeyEventLike) => void>>;
} {
  const listeners = new Map<string, Set<(event: KeyEventLike) => void>>();
  return {
    listeners,
    target: {
      addEventListener(type, listener) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
    },
    emit(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

describe('attachKeyboard', () => {
  it('suppresses the default action for bound keys only', () => {
    const source = new KeyboardSource();
    const { target, emit } = fakeTarget();
    attachKeyboard(target, source);

    let bound = 0;
    let unbound = 0;
    // Arrow keys scroll the page and Enter submits forms; an unbound key must still work.
    emit('keydown', { code: 'ArrowUp', preventDefault: () => (bound += 1) });
    emit('keydown', { code: 'F5', preventDefault: () => (unbound += 1) });
    expect(bound).toBe(1);
    expect(unbound).toBe(0);
    expect(source.read().stickY).toBe(127);
  });

  it('releases every key when the window loses focus', () => {
    const source = new KeyboardSource();
    const { target, emit } = fakeTarget();
    attachKeyboard(target, source);
    emit('keydown', { code: 'KeyZ' });
    expect(source.read().button).toBe(PAD.A);
    emit('blur', { code: '' });
    expect(source.read().button).toBe(0);
  });

  it('removes its listeners and releases keys when detached', () => {
    const source = new KeyboardSource();
    const { target, emit, listeners } = fakeTarget();
    const detach = attachKeyboard(target, source);
    emit('keydown', { code: 'KeyZ' });
    detach();
    expect(source.read().button).toBe(0);
    for (const set of listeners.values()) expect(set.size).toBe(0);
    emit('keydown', { code: 'KeyZ' });
    expect(source.read().button).toBe(0);
  });
});
