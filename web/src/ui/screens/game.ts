import { h, type AppContext } from '../context.js';
import { padStatusBytes } from '../../input/pad.js';
import { TOUCH_ACTIONS, TouchControls, attachTouchControls } from '../../input/touch.js';

/**
 * Game screen.
 *
 * This screen is honest about the state of the project: the canvas, the touch overlay and the
 * performance readout are real, but there is no game core to draw yet. It says so on screen
 * rather than showing a placeholder that could be mistaken for progress.
 *
 * What is real here:
 *  - the canvas is sized to the GameCube aspect ratio (73:60) and the renderer will
 *    present into it (docs/SPEC_PIANO.md §1.3);
 *  - the touch overlay is the one in `web/src/input/touch.ts`: Pointer Events with
 *    `touch-action: none`, a control stick zone, a C-stick zone and one button per action,
 *    writing the same PAD state the keyboard and the Gamepad API write (§4.2). Its output is
 *    printed on screen as the `PADStatus` bytes it would hand the guest, so what the overlay
 *    does is visible instead of claimed;
 *  - the overlay opacity is a real setting.
 *
 * What is not: nothing polls the overlay. There is no simulation loop, because there is no core
 * (docs/OPEN_QUESTIONS.md Q1), so the bytes on screen are what the overlay *would* give the guest
 * on the next tick, updated on the pointer event that changed them.
 */
export function gameScreen(context: AppContext): HTMLElement {
  const screen = h('section', { id: 'screen-game' });
  screen.append(h('h2', { text: 'Game' }));

  const canvas = h('canvas', { id: 'game-canvas', width: '730', height: '600' });
  screen.append(canvas);

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Core not built yet' }),
      h('p', {
        text:
          'melee.wasm does not exist in this repository, by design: it is generated from the operator\'s own disc and is never committed. ' +
          'Once the ISO is available the build runs in CI (see docs/PROGRESS.md and docs/OPEN_QUESTIONS.md) and this canvas is handed to the WebGPU presenter.',
      }),
      h('p', {
        class: 'muted',
        text: 'Nothing on this screen pretends to be the game. The lobby and the transport below it are real and are tested in CI.',
      }),
    ]),
  );

  const controls = new TouchControls({ deadzone: context.settings.controlStickDeadzone });

  const stickZone = h('div', { class: 'stick-zone', id: 'stick-zone' });
  const cStickZone = h('div', { class: 'c-stick-zone', id: 'c-stick-zone' });
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
  document.body.append(overlay);

  const hex = (bytes: Uint8Array): string =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

  const readout = h('p', { class: 'status', id: 'pad-readout' });

  /** Print what the overlay would hand the guest on the next tick. */
  const refresh = (): void => {
    const pad = controls.read();
    readout.textContent = `overlay PADStatus: ${hex(padStatusBytes(pad))}  err=${pad.err}`;
  };
  refresh();

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
      refresh();
      context.log(`touch overlay ${enabled ? 'enabled' : 'disabled'}`);
    },
  });

  const performance = h('p', { class: 'status', id: 'performance', text: 'simulation: not running' });

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
        text: 'PADStatus bytes in the guest\'s own order: button, stick_x, stick_y, c_x, c_y, trig_l, trig_r, a, b, err, pad. Nothing polls this yet — there is no simulation loop — so this is what the overlay would hand the guest on the next tick.',
      }),
      performance,
    ]),
  );

  // The overlay is removed from the document when this screen is replaced, so it does not
  // linger over other screens and cannot leave a finger pressed on a screen nobody is on.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(screen)) {
      observer.disconnect();
      detachTouch();
      for (const type of pointerEvents) overlay.removeEventListener(type, refresh);
      window.removeEventListener('blur', refresh);
      overlay.remove();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return screen;
}
