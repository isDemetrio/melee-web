/**
 * Touch overlay → PAD state.
 *
 * Upstream has no touch overlay: the port is a desktop SDL build with a keyboard, a Gamepad API
 * reader and HID pads. So unlike keyboard.ts and gamepad.ts there is no reference
 * implementation to copy. What is *not* invented here is the target: the overlay writes a
 * `PadState` (pad.ts), and it is treated as a pad, so a phone with the overlay on is a port with
 * a device on it (`err: 0`) exactly like the keyboard path, and it replaces the keyboard for the
 * same reason a physical pad does (controller.ts).
 *
 * Three properties decide whether it is usable, and each one has a test:
 *
 *  1. **Pointers are tracked individually.** A phone has several fingers down at once and the
 *     browser reports them as separate pointer ids, usually on the same element. One
 *     `activePointer` field would make the second finger steal the stick; here every finger has
 *     its own claim, and a zone refuses a second finger while the first one holds it.
 *  2. **A pointer keeps what it started on until it is released.** A finger that slides off a
 *     button still holds it, and a finger that slides out of the stick zone still steers. That
 *     is what `setPointerCapture` is for, and the claim table is what makes the rule explicit
 *     and testable.
 *  3. **The stick starts where the finger lands.** A fixed centre means a touch near the edge of
 *     the zone is full deflection — a dash the player did not ask for. Deflection is measured
 *     from the point the finger went down, and the deadzone the settings screen publishes
 *     applies to it through `applyDeadzone` (pad.ts), the same function the gamepad reader uses.
 *
 * Two deliberate limits, stated rather than hidden:
 *  - L and R are full presses (`TRIGGER_FULL`), like the keyboard's. A touch button cannot
 *    express an analog trigger, so light shield is not available on the overlay.
 *  - The D-pad is not on the overlay (`TOUCH_ACTIONS`). Melee uses it for taunts and for
 *    nothing else in a match, and eight more buttons would cover a phone screen.
 *
 * Nothing here touches the DOM, `navigator` or a clock: `TouchControls` is a state machine over
 * plain numbers, so the unit tests drive it under Node. The DOM wiring is `attachTouchControls`,
 * which takes its elements as arguments and describes them structurally — the same shape of
 * solution as store.ts uses for OPFS, and for the same reason: a fake has to be able to stand in
 * for the platform.
 */

import {
  PAD,
  PAD_BUTTON_BITS,
  STICK_FULL,
  TRIGGER_FULL,
  applyDeadzone,
  clampStick,
  deadzoneRadius,
  disconnectedPad,
  type PadAction,
  type PadState,
} from './pad.js';

/** Which zone a pointer drags in. */
export type TouchZone = 'stick' | 'c-stick';

/** A point in the page's own coordinates: CSS pixels, y growing downward. */
export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The actions the overlay offers as buttons, in the pad's own order.
 *
 * The C-stick directions are absent because the C-stick is a zone here, not four buttons: a
 * button can only push an axis to full deflection, and a half-tilted C-stick is a real input
 * (a soft up-air). The D-pad is absent on purpose, see the header.
 */
export const TOUCH_ACTIONS: readonly PadAction[] = ['A', 'B', 'X', 'Y', 'Z', 'L', 'R', 'Start'];

export interface TouchControlsOptions {
  /**
   * Deadzone as a fraction of full deflection, the same units as
   * `Settings.controlStickDeadzone` (`web/src/ui/settings.ts`) and the same one the gamepad
   * reader takes. 0 disables it, which is what the port does by default.
   */
  readonly deadzone?: number;
}

interface StickGesture {
  readonly pointerId: number;
  /** Where the finger went down. The stick's neutral is here, not at the zone's centre. */
  readonly origin: TouchPoint;
  /** Finger travel for full deflection, in CSS pixels, measured when the finger landed. */
  readonly radius: number;
  /** Where the finger is now. */
  point: TouchPoint;
}

/**
 * The overlay's state: which finger holds what.
 *
 * Every method returns whether the overlay consumed the pointer, so a caller knows whether to
 * suppress the platform's own handling of it. An unconsumed pointer is one the overlay has no
 * business with — a second finger on a held zone, an unknown action, an overlay that is off.
 */
export class TouchControls {
  private readonly deadzone: number;
  private enabledFlag = false;
  private stick: StickGesture | null = null;
  private cStick: StickGesture | null = null;
  /** Pointer id → the action it holds. A map, so two fingers on one button both count. */
  private readonly buttons = new Map<number, PadAction>();

  constructor(options: TouchControlsOptions = {}) {
    this.deadzone = deadzoneRadius(options.deadzone ?? 0);
  }

  /** True while the overlay is on. Off by default: a desktop must not be covered by it. */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  /**
   * Turn the overlay on or off. Turning it off releases every finger: the toggle is on the
   * screen the overlay covers, and a button held at the moment it is switched off would
   * otherwise stay held forever.
   */
  setEnabled(value: boolean): void {
    this.enabledFlag = value;
    if (!value) this.releaseAll();
  }

  /** How many pointers the overlay is tracking. Exposed for the settings screen and tests. */
  get tracked(): number {
    return this.buttons.size + (this.stick ? 1 : 0) + (this.cStick ? 1 : 0);
  }

  /**
   * A finger went down in a zone.
   *
   * Refused when the overlay is off, when the pointer is already claimed, or when another
   * finger is already dragging that zone. `radius` is the finger travel that means full
   * deflection, measured by the caller from the zone's own size; it is captured per gesture
   * because the zone can be resized between touches (a rotation, a URL bar appearing).
   */
  down(pointerId: number, zone: TouchZone, point: TouchPoint, radius: number): boolean {
    if (!this.enabledFlag) return false;
    if (this.claimed(pointerId)) return false;
    const gesture: StickGesture = {
      pointerId,
      origin: point,
      radius: Number.isFinite(radius) && radius > 0 ? radius : 1,
      point,
    };
    if (zone === 'stick') {
      if (this.stick) return false;
      this.stick = gesture;
      return true;
    }
    if (this.cStick) return false;
    this.cStick = gesture;
    return true;
  }

  /**
   * A finger went down on a button. Refused for an action the overlay does not offer, rather
   * than mapped to something that looks close.
   */
  press(pointerId: number, action: PadAction): boolean {
    if (!this.enabledFlag) return false;
    if (this.claimed(pointerId)) return false;
    if (!TOUCH_ACTIONS.includes(action)) return false;
    this.buttons.set(pointerId, action);
    return true;
  }

  /**
   * A claimed pointer moved. A button does not follow the finger — it stays held until it is
   * released — so this only moves a stick.
   */
  move(pointerId: number, point: TouchPoint): boolean {
    const gesture = this.gestureOf(pointerId);
    if (!gesture) return this.claimed(pointerId);
    gesture.point = point;
    return true;
  }

  /** A claimed pointer went up or was cancelled. Releases whatever it held. */
  release(pointerId: number): boolean {
    if (this.buttons.delete(pointerId)) return true;
    if (this.stick?.pointerId === pointerId) {
      this.stick = null;
      return true;
    }
    if (this.cStick?.pointerId === pointerId) {
      this.cStick = null;
      return true;
    }
    return false;
  }

  /**
   * Drop every finger. Called on a lost window and when the overlay is switched off: a
   * `pointerup` delivered to another window never arrives, and a stuck button is worse than a
   * dropped one. The keyboard source releases its held keys for exactly this reason.
   */
  releaseAll(): void {
    this.buttons.clear();
    this.stick = null;
    this.cStick = null;
  }

  /** True when this pointer belongs to the overlay. */
  claimed(pointerId: number): boolean {
    return this.buttons.has(pointerId) || this.gestureOf(pointerId) !== null;
  }

  /**
   * One tick's state.
   *
   * An overlay that is switched off reads as an *unplugged* port (`err: -1`), not as a pad at
   * rest: a caller that forgets to check `enabled` must not make a phone look like a controller
   * that is merely idle, or the guest would keep port 1 alive with nothing plugged into it.
   */
  read(): PadState {
    if (!this.enabledFlag) return disconnectedPad();

    let button = 0;
    for (const action of this.buttons.values()) {
      const bit = PAD_BUTTON_BITS[action];
      if (bit !== undefined) button |= bit;
    }
    // Melee shields from the analog value, so a touch L/R is a full press of both, the way the
    // keyboard's L/R are (`keyboard.ts`, `trigL: button & PAD.L ? TRIGGER_FULL : 0`).
    const trigL = button & PAD.L ? TRIGGER_FULL : 0;
    const trigR = button & PAD.R ? TRIGGER_FULL : 0;

    const stick = this.stick ? this.deflection(this.stick) : { x: 0, y: 0 };
    const cStick = this.cStick ? this.deflection(this.cStick) : { x: 0, y: 0 };

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
      // The overlay is a pad, and the player switched it on: the port is present.
      err: 0,
    };
  }

  private gestureOf(pointerId: number): StickGesture | null {
    if (this.stick?.pointerId === pointerId) return this.stick;
    if (this.cStick?.pointerId === pointerId) return this.cStick;
    return null;
  }

  /**
   * One gesture's stick value, in the state's own units.
   *
   * The DOM's y grows downward and `stick_y` is positive UP (pad.ts), so the vertical term is
   * the *negative* of the finger's downward travel. The result is truncated toward zero and
   * clamped by `clampStick`, and the deadzone is the circular one the port uses, in state
   * units.
   */
  private deflection(gesture: StickGesture): { x: number; y: number } {
    const scale = STICK_FULL / gesture.radius;
    const x = clampStick((gesture.point.x - gesture.origin.x) * scale);
    const y = clampStick((gesture.origin.y - gesture.point.y) * scale);
    return applyDeadzone(x, y, this.deadzone);
  }
}

/** A rectangle in CSS pixels. `DOMRect` satisfies it, and so does a plain object. */
export interface TouchRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Full deflection distance for a zone: half its smaller side.
 *
 * A square zone therefore has a stick whose full travel is a radius, and a wide one is not
 * harder to push sideways than up. A zone that has not been laid out yet (0 × 0, which is what
 * `display: none` reports) still gets 1 px rather than a division by zero.
 */
export function zoneRadius(rect: TouchRect): number {
  const smaller = Math.min(rect.width, rect.height);
  if (!Number.isFinite(smaller) || smaller <= 0) return 1;
  return Math.max(1, smaller / 2);
}

/**
 * The event names the adapter listens for.
 *
 * `blur` is in the list because a lost window is a real way to lose every finger at once, and it
 * is the same reason `attachKeyboard` listens for it.
 */
export type TouchEventName = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'blur';

/**
 * Anything the adapter can attach a listener to: a zone, a button, or the window.
 *
 * The listener is typed for `Event` rather than for `PointerEvent` on purpose: a real
 * `HTMLElement` accepts an `EventListener` and nothing else for a `string` event name, so a
 * `(event: PointerEvent) => void` here would make every real element fail to typecheck. The
 * pointer fields are read through `pointerOf`, which checks for them at runtime.
 */
export interface TouchListenerTarget {
  addEventListener(type: TouchEventName, listener: (event: Event) => void): void;
  removeEventListener(type: TouchEventName, listener: (event: Event) => void): void;
}

/** A zone or a button: a listener target that can also be measured and can capture a pointer. */
export interface TouchZoneLike extends TouchListenerTarget {
  getBoundingClientRect(): TouchRect;
  /**
   * Optional because a platform without pointer capture still works for a gesture that stays
   * inside the element; the adapter checks before calling. It also throws for a pointer that is
   * already gone, which the adapter swallows.
   */
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

/** One button element and the action it carries. An element carries exactly one action. */
export interface TouchButtonPart {
  readonly action: PadAction;
  readonly element: TouchZoneLike;
}

export interface TouchOverlayParts {
  /** The control stick zone. */
  readonly stick?: TouchZoneLike | null;
  /** The C-stick zone. */
  readonly cStick?: TouchZoneLike | null;
  readonly buttons?: readonly TouchButtonPart[];
  /** The window, when the caller has one: it is where `blur` is delivered. */
  readonly lifecycle?: TouchListenerTarget | null;
}

/**
 * Wire an overlay's elements to a `TouchControls`.
 *
 * Returns the detach function; calling it removes every listener this call added and releases
 * every held finger, so a screen that is replaced cannot leave the port pressed.
 *
 * `setPointerCapture` is what keeps a gesture alive when the finger leaves the element. It is
 * requested on the element the finger went down on, for the pointers the overlay consumed —
 * never for the ones it refused, which belong to whatever is underneath.
 */
export function attachTouchControls(
  parts: TouchOverlayParts,
  controls: TouchControls,
): () => void {
  const teardown: Array<() => void> = [];

  const listen = (
    element: TouchListenerTarget,
    type: TouchEventName,
    listener: (event: Event) => void,
  ): void => {
    element.addEventListener(type, listener);
    teardown.push(() => element.removeEventListener(type, listener));
  };

  const zone = (element: TouchZoneLike, kind: TouchZone): void => {
    listen(element, 'pointerdown', (event) => {
      const pointer = pointerOf(event);
      if (!pointer) return;
      const radius = zoneRadius(element.getBoundingClientRect());
      if (!controls.down(pointer.pointerId, kind, pointer.point, radius)) return;
      capture(element, pointer.pointerId);
      suppress(event);
    });
    listen(element, 'pointermove', (event) => {
      const pointer = pointerOf(event);
      if (!pointer) return;
      if (controls.move(pointer.pointerId, pointer.point)) suppress(event);
    });
    const release = (event: Event): void => {
      const pointer = pointerOf(event);
      if (!pointer) return;
      if (controls.release(pointer.pointerId)) releaseCapture(element, pointer.pointerId);
    };
    listen(element, 'pointerup', release);
    listen(element, 'pointercancel', release);
  };

  if (parts.stick) zone(parts.stick, 'stick');
  if (parts.cStick) zone(parts.cStick, 'c-stick');

  for (const part of parts.buttons ?? []) {
    const { action, element } = part;
    listen(element, 'pointerdown', (event) => {
      const pointer = pointerOf(event);
      if (!pointer) return;
      if (!controls.press(pointer.pointerId, action)) return;
      capture(element, pointer.pointerId);
      suppress(event);
    });
    // No `pointermove` here: a button does not follow the finger, so a move must not release it.
    const release = (event: Event): void => {
      const pointer = pointerOf(event);
      if (!pointer) return;
      if (controls.release(pointer.pointerId)) releaseCapture(element, pointer.pointerId);
    };
    listen(element, 'pointerup', release);
    listen(element, 'pointercancel', release);
  }

  if (parts.lifecycle) {
    listen(parts.lifecycle, 'blur', () => controls.releaseAll());
  }

  return () => {
    for (const remove of teardown.splice(0)) remove();
    controls.releaseAll();
  };
}

/** The pointer fields, or null when the event is not a pointer event the overlay can use. */
export function pointerOf(event: Event): { pointerId: number; point: TouchPoint } | null {
  const candidate = event as unknown as Partial<{
    pointerId: number;
    clientX: number;
    clientY: number;
  }>;
  if (typeof candidate.pointerId !== 'number') return null;
  return {
    pointerId: candidate.pointerId,
    point: {
      x: typeof candidate.clientX === 'number' ? candidate.clientX : 0,
      y: typeof candidate.clientY === 'number' ? candidate.clientY : 0,
    },
  };
}

/**
 * Stop the platform's own handling of a pointer the overlay consumed.
 *
 * `touch-action: none` on the zone already stops the page scrolling; this additionally stops the
 * synthetic mouse events and the long-press selection menu where the platform still offers them.
 */
function suppress(event: Event): void {
  const preventable = event as unknown as { preventDefault?: () => void };
  preventable.preventDefault?.();
}

/** Ask for the pointer, tolerating a platform without capture and a pointer that has gone. */
function capture(element: TouchZoneLike, pointerId: number): void {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // The pointer was already released, which a fast tap can do before this runs.
  }
}

function releaseCapture(element: TouchZoneLike, pointerId: number): void {
  try {
    element.releasePointerCapture?.(pointerId);
  } catch {
    // Same: the browser may have released it already.
  }
}
