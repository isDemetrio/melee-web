/**
 * The touch overlay: the state machine, then the DOM wiring.
 *
 * The machine is driven with plain numbers and the wiring with a fake pointer surface, so both
 * run under Node. What is asserted here is the behaviour a player would notice if it were wrong:
 * a second finger must not steal the stick, a finger that slides off a button must keep holding
 * it, the stick must start where the finger landed, and the whole thing must let go when the
 * window is lost.
 */

import { describe, expect, it } from 'vitest';
import { PAD, disconnectedPad, neutralPad } from '../../src/input/pad.js';
import {
  TOUCH_ACTIONS,
  TouchControls,
  attachTouchControls,
  knobOffset,
  pointerOf,
  zoneRadius,
} from '../../src/input/touch.js';
import { FakePointerZone } from './fakes/fakePointerZone.js';

/** Full-deflection travel for the fake zone's 200 × 100 layout. */
const RADIUS = 50;

/** An overlay that is switched on, which is the state every gesture test starts from. */
function enabled(options: { deadzone?: number } = {}): TouchControls {
  const controls = new TouchControls(options);
  controls.setEnabled(true);
  return controls;
}

describe('TouchControls', () => {
  it('reads as an unplugged port until the overlay is switched on', () => {
    // A caller that forgets to check `enabled` must not make a phone look like a controller
    // that is merely idle: the guest would keep port 1 alive with nothing plugged into it.
    const controls = new TouchControls();
    expect(controls.read()).toEqual(disconnectedPad());
    expect(controls.down(1, 'stick', { x: 0, y: 0 }, RADIUS)).toBe(false);
    expect(controls.press(1, 'A')).toBe(false);

    controls.setEnabled(true);
    expect(controls.read()).toEqual(neutralPad());
  });

  it('measures the stick from the finger, not from the zone', () => {
    // A fixed centre would make a touch near the edge of the zone a full deflection: a dash the
    // player did not ask for. The machine never learns the zone's geometry, so this holds
    // wherever the finger lands.
    const controls = enabled();
    expect(controls.down(1, 'stick', { x: 190, y: 95 }, RADIUS)).toBe(true);
    expect(controls.read().stickX).toBe(0);
    expect(controls.read().stickY).toBe(0);

    controls.release(1);
    expect(controls.down(1, 'stick', { x: 3, y: 2 }, RADIUS)).toBe(true);
    expect(controls.read().stickX).toBe(0);
    expect(controls.read().stickY).toBe(0);
  });

  it('deflects in the state\u2019s own units, with y positive up', () => {
    const controls = enabled();
    controls.down(1, 'stick', { x: 100, y: 50 }, RADIUS);

    controls.move(1, { x: 150, y: 50 });
    expect(controls.read().stickX).toBe(127);
    expect(controls.read().stickY).toBe(0);

    controls.move(1, { x: 100, y: 0 });
    expect(controls.read().stickX).toBe(0);
    // The DOM's y grows downward and `stick_y` is positive UP (pad.ts).
    expect(controls.read().stickY).toBe(127);

    controls.move(1, { x: 100, y: 100 });
    expect(controls.read().stickY).toBe(-127);

    controls.move(1, { x: 50, y: 50 });
    expect(controls.read().stickX).toBe(-127);
  });

  it('truncates toward zero and clamps at full deflection', () => {
    const controls = enabled();
    controls.down(1, 'stick', { x: 100, y: 50 }, RADIUS);

    // 25 px of 50 is half travel: 25 × 127/50 = 63.5, truncated the way the port's axis
    // conversion truncates (gamepad.ts).
    controls.move(1, { x: 125, y: 50 });
    expect(controls.read().stickX).toBe(63);

    controls.move(1, { x: 900, y: 50 });
    expect(controls.read().stickX).toBe(127);
  });

  it('applies the circular deadzone the settings screen publishes', () => {
    // 0.25 is the same setting the settings screen stores, and it is 20 state units
    // (deadzoneRadius, pad.ts).
    const controls = enabled({ deadzone: 0.25 });
    controls.down(1, 'stick', { x: 100, y: 50 }, RADIUS);

    controls.move(1, { x: 106, y: 50 });
    expect(controls.read().stickX).toBe(0);

    controls.move(1, { x: 110, y: 50 });
    expect(controls.read().stickX).toBe(25);

    // Circular, not per axis: 15 units on each axis is inside the 20-unit radius on either one,
    // but the vector is 21 units long, so the diagonal survives where a per-axis deadzone would
    // have zeroed both (pad.ts, applyDeadzone).
    controls.move(1, { x: 106, y: 44 });
    expect(controls.read().stickX).toBe(15);
    expect(controls.read().stickY).toBe(15);

    controls.move(1, { x: 105, y: 45 });
    expect(controls.read().stickX).toBe(0);
    expect(controls.read().stickY).toBe(0);
  });

  it('refuses a second finger in a zone the first one holds', () => {
    const controls = enabled();
    expect(controls.down(1, 'stick', { x: 100, y: 50 }, RADIUS)).toBe(true);
    expect(controls.down(2, 'stick', { x: 20, y: 20 }, RADIUS)).toBe(false);

    controls.move(2, { x: 200, y: 50 });
    expect(controls.read().stickX).toBe(0);

    controls.move(1, { x: 150, y: 50 });
    expect(controls.read().stickX).toBe(127);

    // Once the first finger is gone the zone is free again.
    controls.release(1);
    expect(controls.down(2, 'stick', { x: 20, y: 20 }, RADIUS)).toBe(true);
  });

  it('refuses a pointer that is already claimed', () => {
    const controls = enabled();
    expect(controls.down(1, 'stick', { x: 100, y: 50 }, RADIUS)).toBe(true);
    expect(controls.press(1, 'A')).toBe(false);
    expect(controls.down(1, 'c-stick', { x: 0, y: 0 }, RADIUS)).toBe(false);
    expect(controls.read().button).toBe(0);
  });

  it('reads the stick and a button from two fingers at once', () => {
    const controls = enabled();
    controls.down(1, 'stick', { x: 100, y: 50 }, RADIUS);
    controls.press(2, 'A');
    controls.move(1, { x: 150, y: 50 });

    const state = controls.read();
    expect(state.button).toBe(PAD.A);
    expect(state.stickX).toBe(127);
    expect(state.err).toBe(0);
  });

  it('holds a button until it is released, and one release is not enough for two fingers', () => {
    const controls = enabled();
    expect(controls.press(1, 'B')).toBe(true);
    expect(controls.press(2, 'B')).toBe(true);
    expect(controls.read().button).toBe(PAD.B);

    // Two fingers on one button is not two presses: releasing one must not release the other.
    controls.release(1);
    expect(controls.read().button).toBe(PAD.B);

    controls.release(2);
    expect(controls.read().button).toBe(0);
  });

  it('makes L and R full presses, and sets no trigger without them', () => {
    const controls = enabled();
    controls.press(1, 'L');
    expect(controls.read().trigL).toBe(255);
    expect(controls.read().trigR).toBe(0);
    expect(controls.read().button & PAD.L).toBe(PAD.L);

    controls.press(2, 'R');
    expect(controls.read().trigR).toBe(255);

    controls.release(1);
    controls.release(2);
    expect(controls.read().trigL).toBe(0);
    expect(controls.read().button).toBe(0);
  });

  it('refuses an action the overlay does not offer', () => {
    // The D-pad and the C-stick directions are not on the overlay (touch.ts, TOUCH_ACTIONS).
    // Refusing them is the point: a silent mapping to something close would be a wrong input.
    const controls = enabled();
    expect(controls.press(1, 'DUp')).toBe(false);
    expect(controls.press(2, 'CLeft')).toBe(false);
    expect(controls.press(3, 'SRight')).toBe(false);
    expect(controls.read().button).toBe(0);
    expect(controls.tracked).toBe(0);

    for (const action of TOUCH_ACTIONS) {
      expect(controls.press(4, action)).toBe(true);
      controls.release(4);
    }
  });

  it('gives the C-stick its own zone', () => {
    const controls = enabled();
    controls.down(1, 'c-stick', { x: 100, y: 50 }, RADIUS);
    controls.move(1, { x: 150, y: 0 });

    const state = controls.read();
    expect(state.subX).toBe(127);
    expect(state.subY).toBe(127);
    expect(state.stickX).toBe(0);
    expect(state.stickY).toBe(0);
  });

  it('does not consume a move from a pointer it never claimed', () => {
    const controls = enabled();
    expect(controls.move(9, { x: 10, y: 10 })).toBe(false);
    expect(controls.release(9)).toBe(false);
    expect(controls.claimed(9)).toBe(false);
  });

  it('releases every finger when it is switched off, and on a lost window', () => {
    const controls = enabled();
    controls.press(1, 'A');
    controls.down(2, 'stick', { x: 100, y: 50 }, RADIUS);
    controls.down(3, 'c-stick', { x: 100, y: 50 }, RADIUS);
    expect(controls.tracked).toBe(3);

    controls.setEnabled(false);
    expect(controls.tracked).toBe(0);
    expect(controls.read()).toEqual(disconnectedPad());

    controls.setEnabled(true);
    controls.press(1, 'A');
    controls.releaseAll();
    expect(controls.tracked).toBe(0);
    expect(controls.read()).toEqual(neutralPad());
  });
});

describe('drawing the overlay', () => {
  it('describes the held stick without letting the drawing move it', () => {
    const controls = enabled();
    expect(controls.view('stick')).toBeNull();

    controls.down(1, 'stick', { x: 100, y: 50 }, RADIUS);
    controls.move(1, { x: 125, y: 50 });
    const view = controls.view('stick');
    expect(view).toEqual({ origin: { x: 100, y: 50 }, point: { x: 125, y: 50 }, radius: RADIUS });
    expect(controls.view('c-stick')).toBeNull();

    // A copy: writing to it is not a way to the PAD state.
    (view as { point: { x: number; y: number } }).point = { x: 900, y: 50 };
    expect(controls.read().stickX).toBe(63);

    controls.release(1);
    expect(controls.view('stick')).toBeNull();
  });

  it('reads the same bytes whether or not anything is drawn', () => {
    // The drawing is read-only: the same gesture, drawn after every move or never, writes the
    // same PAD state.
    const drawn = enabled();
    const plain = enabled();
    const path = [{ x: 110, y: 50 }, { x: 140, y: 20 }, { x: 300, y: -200 }, { x: 80, y: 90 }];
    drawn.down(1, 'stick', { x: 100, y: 50 }, RADIUS);
    plain.down(1, 'stick', { x: 100, y: 50 }, RADIUS);
    for (const point of path) {
      drawn.move(1, point);
      plain.move(1, point);
      const view = drawn.view('stick');
      if (view) knobOffset(view);
      expect(drawn.read()).toEqual(plain.read());
    }
  });

  it('keeps the knob on the finger inside the rim and on the rim outside it', () => {
    const origin = { x: 100, y: 50 };
    expect(knobOffset({ origin, point: origin, radius: RADIUS })).toEqual({ x: 0, y: 0 });
    expect(knobOffset({ origin, point: { x: 125, y: 30 }, radius: RADIUS })).toEqual({ x: 25, y: -20 });
    // Full deflection to the right is the rim, and past it the knob stops there.
    expect(knobOffset({ origin, point: { x: 150, y: 50 }, radius: RADIUS })).toEqual({ x: 50, y: 0 });
    expect(knobOffset({ origin, point: { x: 400, y: 50 }, radius: RADIUS })).toEqual({ x: 50, y: 0 });
    // Past the rim on a diagonal it stays on the circle, in the finger's direction.
    const diagonal = knobOffset({ origin, point: { x: 200, y: -50 }, radius: RADIUS });
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(RADIUS, 9);
    expect(diagonal.x).toBeCloseTo(-diagonal.y, 9);
  });

  it('reports a button held while any finger holds it', () => {
    const controls = enabled();
    expect(controls.held('A')).toBe(false);
    controls.press(1, 'A');
    controls.press(2, 'A');
    expect(controls.held('A')).toBe(true);
    expect(controls.held('B')).toBe(false);
    controls.release(1);
    expect(controls.held('A')).toBe(true);
    controls.release(2);
    expect(controls.held('A')).toBe(false);
  });
});

describe('zoneRadius', () => {
  it('is half the smaller side, and never zero', () => {
    expect(zoneRadius({ left: 0, top: 0, width: 200, height: 100 })).toBe(50);
    expect(zoneRadius({ left: 0, top: 0, width: 100, height: 100 })).toBe(50);
    // `display: none` measures 0 × 0, and a division by it would be an infinite stick.
    expect(zoneRadius({ left: 0, top: 0, width: 0, height: 0 })).toBe(1);
    expect(zoneRadius({ left: 0, top: 0, width: 0, height: 100 })).toBe(1);
    expect(zoneRadius({ left: 0, top: 0, width: Number.NaN, height: 100 })).toBe(1);
  });
});

describe('pointerOf', () => {
  it('reads the fields a pointer event carries, and refuses anything else', () => {
    const pointer = { pointerId: 7, clientX: 12, clientY: 34 } as unknown as Event;
    expect(pointerOf(pointer)).toEqual({ pointerId: 7, point: { x: 12, y: 34 } });

    // A `blur`, or anything else without a pointer id, is not a pointer event.
    expect(pointerOf({} as unknown as Event)).toBeNull();
    expect(pointerOf({ pointerId: 'seven' } as unknown as Event)).toBeNull();

    // A pointer event without coordinates is still a pointer: it lands at the origin.
    const bare = { pointerId: 3 } as unknown as Event;
    expect(pointerOf(bare)).toEqual({ pointerId: 3, point: { x: 0, y: 0 } });
  });
});

describe('attachTouchControls', () => {
  /** An overlay with both zones, one button, and a window to lose. */
  function build(options: { enabled?: boolean; deadzone?: number } = {}) {
    const controls = new TouchControls({ deadzone: options.deadzone });
    controls.setEnabled(options.enabled ?? true);
    const stick = new FakePointerZone();
    const cStick = new FakePointerZone();
    const button = new FakePointerZone();
    const lifecycle = new FakePointerZone();
    const detach = attachTouchControls(
      { stick, cStick, buttons: [{ action: 'A', element: button }], lifecycle },
      controls,
    );
    return { controls, stick, cStick, button, lifecycle, detach };
  }

  it('deflects the stick from a drag, and captures the pointer it consumed', () => {
    const { controls, stick } = build();

    stick.emit('pointerdown', 1, { x: 100, y: 50 });
    expect(controls.read().stickX).toBe(0);

    stick.emit('pointermove', 1, { x: 150, y: 50 });
    expect(controls.read().stickX).toBe(127);

    // Capture is what keeps the gesture alive when the finger leaves the element.
    expect(stick.captured).toEqual([1]);
    expect(stick.prevented).toBeGreaterThan(0);

    stick.emit('pointerup', 1, { x: 150, y: 50 });
    expect(controls.read().stickX).toBe(0);
    expect(stick.released).toEqual([1]);
  });

  it('takes the full-deflection travel from the zone\u2019s own layout', () => {
    const { controls, stick } = build();
    stick.rect = { left: 0, top: 0, width: 100, height: 100 };

    stick.emit('pointerdown', 1, { x: 50, y: 50 });
    stick.emit('pointermove', 1, { x: 100, y: 50 });
    expect(controls.read().stickX).toBe(127);
  });

  it('still gives a usable stick to a zone that cannot be measured', () => {
    const { controls, stick } = build();
    stick.rect = { left: 0, top: 0, width: 0, height: 0 };

    stick.emit('pointerdown', 1, { x: 0, y: 0 });
    stick.emit('pointermove', 1, { x: 1, y: 0 });
    expect(controls.read().stickX).toBe(127);
  });

  it('holds a button across a move, and releases it on pointerup or pointercancel', () => {
    const { controls, button } = build();

    button.emit('pointerdown', 4, { x: 10, y: 10 });
    expect(controls.read().button).toBe(PAD.A);
    expect(button.captured).toEqual([4]);

    // A button does not follow the finger: the move must not release it.
    button.emit('pointermove', 4, { x: 400, y: 400 });
    expect(controls.read().button).toBe(PAD.A);

    button.emit('pointerup', 4, { x: 400, y: 400 });
    expect(controls.read().button).toBe(0);

    button.emit('pointerdown', 5, { x: 10, y: 10 });
    button.emit('pointercancel', 5, { x: 10, y: 10 });
    expect(controls.read().button).toBe(0);
  });

  it('wires the C-stick zone to the C-stick', () => {
    const { controls, cStick, stick } = build();

    cStick.emit('pointerdown', 2, { x: 100, y: 50 });
    cStick.emit('pointermove', 2, { x: 150, y: 50 });
    expect(controls.read().subX).toBe(127);
    expect(controls.read().stickX).toBe(0);
    expect(stick.captured).toEqual([]);
  });

  it('ignores an event with no pointer id instead of throwing', () => {
    const { controls, stick, button } = build();

    stick.emit('pointerdown');
    button.emit('pointerdown');
    stick.emit('pointermove');

    expect(controls.tracked).toBe(0);
    expect(stick.prevented).toBe(0);
    expect(stick.captured).toEqual([]);
  });

  it('releases every finger when the window is lost', () => {
    // A `pointerup` delivered to another window never arrives; a stuck button is worse than a
    // dropped one. This is why the keyboard source releases its keys on blur too.
    const { controls, button, lifecycle } = build();

    button.emit('pointerdown', 6, { x: 10, y: 10 });
    expect(controls.read().button).toBe(PAD.A);

    lifecycle.emit('blur');
    expect(controls.read().button).toBe(0);
    expect(controls.tracked).toBe(0);
  });

  it('consumes nothing and captures nothing while the overlay is off', () => {
    const { controls, stick, button } = build({ enabled: false });

    stick.emit('pointerdown', 1, { x: 100, y: 50 });
    button.emit('pointerdown', 2, { x: 10, y: 10 });

    expect(controls.tracked).toBe(0);
    expect(stick.captured).toEqual([]);
    expect(button.captured).toEqual([]);
    expect(stick.prevented).toBe(0);
    expect(controls.read()).toEqual(disconnectedPad());
  });

  it('captures only the pointer it consumed', () => {
    const { controls, stick } = build();

    stick.emit('pointerdown', 1, { x: 100, y: 50 });
    stick.emit('pointerdown', 2, { x: 20, y: 20 });

    expect(stick.captured).toEqual([1]);
    expect(controls.tracked).toBe(1);
  });

  it('removes every listener and lets go when detached', () => {
    const { controls, stick, button, lifecycle, detach } = build();

    button.emit('pointerdown', 1, { x: 10, y: 10 });
    expect(controls.read().button).toBe(PAD.A);
    expect(stick.listenerCount).toBe(4);
    expect(button.listenerCount).toBe(3);
    expect(lifecycle.listenerCount).toBe(1);

    detach();

    expect(controls.read().button).toBe(0);
    expect(controls.tracked).toBe(0);
    expect(stick.listenerCount).toBe(0);
    expect(button.listenerCount).toBe(0);
    expect(lifecycle.listenerCount).toBe(0);

    // And the detached overlay is inert, not merely forgotten.
    stick.emit('pointerdown', 2, { x: 100, y: 50 });
    expect(controls.tracked).toBe(0);
  });
});
