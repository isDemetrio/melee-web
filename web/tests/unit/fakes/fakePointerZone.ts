/**
 * A fake pointer surface: a zone or a window the touch overlay can be attached to.
 *
 * The overlay is written against a structural description of an element (touch.ts,
 * `TouchZoneLike`), so this fake is what stands in for the platform in the unit tests. It keeps
 * the parts of the platform the overlay is written around rather than a convenient version:
 *
 *  - `emit` delivers an event to every listener registered for that type, and the pointer fields
 *    are plain numbers, exactly as a `PointerEvent` carries them;
 *  - an event emitted without a pointer id has no `pointerId` at all, which is the case the
 *    overlay has to tolerate (a `blur`, or a synthetic event);
 *  - `preventDefault` is counted, so "the overlay consumed this pointer" is an assertion;
 *  - `setPointerCapture` is recorded, so the claim rule is observable from the outside.
 *
 * It is not a browser: capture does not reroute anything (the test delivers every event to the
 * element it is emitted on, which is what capture achieves in a real page), and there is no
 * layout — the rect is whatever the test sets.
 */

import type {
  TouchEventName,
  TouchPoint,
  TouchRect,
  TouchZoneLike,
} from '../../../src/input/touch.js';

export class FakePointerZone implements TouchZoneLike {
  private readonly listeners = new Map<TouchEventName, Set<(event: Event) => void>>();
  /** Test-only: the pointer ids this element was asked to capture, in order. */
  readonly captured: number[] = [];
  /** Test-only: the pointer ids it was asked to release. */
  readonly released: number[] = [];
  /** Test-only: how many times the overlay suppressed the platform's own handling. */
  prevented = 0;
  /** Test-only: the layout. 200 × 100 means a full-deflection radius of 50 px. */
  rect: TouchRect = { left: 0, top: 0, width: 200, height: 100 };

  addEventListener(type: TouchEventName, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: TouchEventName, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect(): TouchRect {
    return this.rect;
  }

  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.released.push(pointerId);
  }

  /** Test-only: how many listeners are registered, over every event type. */
  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /**
   * Deliver one event, the way the platform would.
   *
   * Without a pointer id the event carries none, which is how a `blur` arrives.
   */
  emit(type: TouchEventName, pointerId?: number, point: TouchPoint = { x: 0, y: 0 }): void {
    const event = (
      pointerId === undefined
        ? { preventDefault: () => { this.prevented += 1; } }
        : {
            pointerId,
            clientX: point.x,
            clientY: point.y,
            preventDefault: () => { this.prevented += 1; },
          }
    ) as unknown as Event;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}
