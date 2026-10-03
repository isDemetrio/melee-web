import { h, type AppContext } from '../context.js';
import { padStatusBytes } from '../../input/pad.js';
import {
  TOUCH_ACTIONS,
  TouchControls,
  attachTouchControls,
  knobOffset,
  zoneRadius,
  type TouchZone,
} from '../../input/touch.js';

import { PlaySession } from '../../play/session.js';

export function gameScreen(context: AppContext): HTMLElement {
  const screen = h('section', { id: 'screen-game' });
  screen.append(h('h2', { text: 'Game' }));

  const canvas = h('canvas', { id: 'game-canvas', width: '640', height: '480' });
  const stage = h('div', { id: 'game-stage' }, [canvas]);
  screen.append(stage);

  const controls = new TouchControls({ deadzone: context.settings.controlStickDeadzone });

  // Each zone draws a base and a knob. Neither takes pointer events (styles.css), so the finger
  // still lands on the zone and the gesture, and the bytes it writes, are the zone's as before.
  const stickKnob = h('div', { class: 'stick-knob', id: 'stick-knob' });
  const stickBase = h('div', { class: 'stick-base', id: 'stick-base' }, [stickKnob]);
  const stickZone = h('div', { class: 'stick-zone', id: 'stick-zone' }, [stickBase]);
  const cStickKnob = h('div', { class: 'stick-knob', id: 'c-stick-knob', text: 'C' });
  const cStickBase = h('div', { class: 'stick-base', id: 'c-stick-base' }, [cStickKnob]);
  const cStickZone = h('div', { class: 'c-stick-zone', id: 'c-stick-zone' }, [cStickBase]);
  // One element per action, and the same objects are what the adapter is given: an element that
  // is not wired to an action is a button that does nothing.
  const buttons = TOUCH_ACTIONS.map((action) => ({
    action,
    element: h('div', {
      class: 'touch-button',
      id: `touch-${action.toLowerCase()}`,
      'data-action': action,
      text: action,
    }),
  }));
  const buttonZone = h(
    'div',
    { class: 'button-zone', id: 'button-zone' },
    buttons.map((button) => button.element),
  );

  const overlay = h('div', { id: 'touch-overlay', 'data-enabled': 'false' }, [
    stickZone,
    cStickZone,
    buttonZone,
  ]);
  stage.append(overlay);
  overlay.style.opacity = String(context.settings.touchOverlayOpacity);
  let session: PlaySession | null = null;

  const hex = (bytes: Uint8Array): string =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

  const readout = h('p', { class: 'status', id: 'pad-readout' });

  /**
   * Draw one stick. At rest the base is centred in its zone; under a finger it sits where the
   * finger landed, because that is the stick's neutral (touch.ts), and the knob follows the
   * finger. The base's radius is the full-deflection travel, measured the way the gesture
   * measures it, so the rim is where the stick reads 127.
   */
  const paintStick = (zone: HTMLElement, base: HTMLElement, knob: HTMLElement, kind: TouchZone): void => {
    const rect = zone.getBoundingClientRect();
    const view = controls.view(kind);
    const radius = view ? view.radius : zoneRadius(rect);
    const centre = view
      ? { x: view.origin.x - rect.left, y: view.origin.y - rect.top }
      : { x: rect.width / 2, y: rect.height / 2 };
    const offset = view ? knobOffset(view) : { x: 0, y: 0 };
    base.style.width = `${2 * radius}px`;
    base.style.height = `${2 * radius}px`;
    base.style.left = `${centre.x}px`;
    base.style.top = `${centre.y}px`;
    base.dataset.active = String(view !== null);
    knob.style.transform = `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`;
  };
  const paint = (): void => {
    paintStick(stickZone, stickBase, stickKnob, 'stick');
    paintStick(cStickZone, cStickBase, cStickKnob, 'c-stick');
    for (const { action, element } of buttons) element.dataset.pressed = String(controls.held(action));
  };

  /** Publish input immediately after touch state changes, and redraw the overlay from it. */
  const refresh = (): void => {
    session?.publish();
    const pad = controls.read();
    readout.textContent = `overlay PADStatus: ${hex(padStatusBytes(pad))}  err=${pad.err}`;
    paint();
  };
  refresh();
  // A rotation or a URL bar resizes the zones without a pointer event; the resting base follows.
  const resize = new ResizeObserver(paint);
  resize.observe(overlay);

  const pointerEvents = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;
  // The overlay root has `pointer-events: none`, so it is never a target; the events bubble up
  // from the zones and the buttons, including the ones a captured pointer is retargeted to.
  for (const type of pointerEvents) overlay.addEventListener(type, refresh);

  const detachTouch = attachTouchControls(
    {
      stick: stickZone,
      cStick: cStickZone,
      buttons,
      lifecycle: window,
    },
    controls,
  );
  // Registered after the overlay, so a lost window releases the fingers and then repaints.
  window.addEventListener('blur', refresh);

  const overlayToggle = h('input', {
    id: 'touch-overlay-toggle',
    type: 'checkbox',
    onchange: (event) => {
      const enabled = (event.target as HTMLInputElement).checked;
      // Switching the overlay on makes it a pad for the port, and switching it off releases
      // every finger the player was holding (touch.ts, setEnabled).
      controls.setEnabled(enabled);
      overlay.dataset.enabled = String(enabled);
      // With the overlay on, the stage is pinned to the top of the viewport (styles.css), so the
      // game and its controls stay on screen while the rest of the page scrolls under them.
      stage.dataset.touch = String(enabled);
      // The zones sit on the stage and the toggle sits below it, so reaching the toggle can scroll
      // the stage out of the viewport, and a point outside the viewport hits nothing. Bring the
      // controls back into view; aligning their bottom also keeps them on a short landscape phone.
      // With the pin this is a fallback: a pinned stage is already in view.
      const box = overlay.getBoundingClientRect();
      if (enabled && (box.top < 0 || box.bottom > window.innerHeight)) {
        overlay.scrollIntoView({ block: 'end' });
      }
      refresh();
      context.log(`touch overlay ${enabled ? 'enabled' : 'disabled'}`);
    },
  });

  const performance = h('p', { class: 'status', id: 'performance', text: 'Choose Play to load the disc and start the game.' });
  const picker = h('input', { id: 'game-disc', type: 'file', accept: '.iso,.gcm', 'aria-label': 'Local disc (optional)' });
  const play = h('button', { id: 'game-play', text: 'Play', onClick: () => {
    session?.stop();
    session = new PlaySession(canvas, controls, context.settings.controlStickDeadzone,
      (text) => { performance.textContent = text; }, (text) => context.log(text));
    void session.start(picker.files?.[0] ?? null);
  } });
  const stop = h('button', { id: 'game-stop', text: 'Stop', onClick: () => {
    session?.stop();
    session = null;
    performance.textContent = 'Stopped. Press Play to restart.';
  } });
  screen.append(h('div', { class: 'panel' }, [
    h('p', { text: 'Play loads the operator disc from the verified cache / server. You can also select a local ISO. Starts at the game menus; port 1 uses controller, touch or keyboard. Audio and online play are not connected yet. Leaving Game stops the session.' }),
    picker, h('div', { class: 'row' }, [play, stop]), performance,
  ]));

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Input' }),
      h('div', { class: 'row' }, [
        h('label', { class: 'row' }, [overlayToggle, 'touch overlay']),
        h('label', { class: 'row' }, [
          h('input', {
            type: 'range',
            min: '15',
            max: '100',
            value: String(Math.round(context.settings.touchOverlayOpacity * 100)),
            oninput: (event) => {
              const value = Number((event.target as HTMLInputElement).value) / 100;
              context.updateSettings({ touchOverlayOpacity: value });
              overlay.style.opacity = String(value);
            },
          }),
          'opacity',
        ]),
      ]),
      h('p', {
        class: 'muted',
        text: 'A physical controller via the Gamepad API is the recommended way to play; the overlay is the fallback. The overlay has no analog L/R, so a light shield needs a controller or a keyboard.',
      }),
      readout,
      h('p', {
        class: 'muted',
        text: 'Live input is published through shared memory while the core runs. Keyboard: arrows = stick, Z/X = A/B, C/V = X/Y, Enter = Start, Q/W = L/R, E = Z, I/J/K/L = C-stick.',
      }),

    ]),
  );

  // The overlay is removed from the document when this screen is replaced, so it does not
  // linger over other screens and cannot leave a finger pressed on a screen nobody is on.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(screen)) {
      observer.disconnect();
      resize.disconnect();
      session?.stop();
      detachTouch();
      for (const type of pointerEvents) overlay.removeEventListener(type, refresh);
      window.removeEventListener('blur', refresh);
      overlay.remove();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return screen;
}
