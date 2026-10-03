import { h, type AppContext } from '../context.js';
import { padStatusBytes } from '../../input/pad.js';
import { TOUCH_ACTIONS, TouchControls, attachTouchControls } from '../../input/touch.js';

import { PlaySession } from '../../play/session.js';
import { ReportControls } from '../../play/report-panel.js';

export function gameScreen(context: AppContext): HTMLElement {
  const screen = h('section', { id: 'screen-game' });
  screen.append(h('h2', { text: 'Game' }));

  const canvas = h('canvas', { id: 'game-canvas', width: '640', height: '480' });
  const stage = h('div', { id: 'game-stage' }, [canvas]);
  screen.append(stage);

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
  stage.append(overlay);
  overlay.style.opacity = String(context.settings.touchOverlayOpacity);
  let session: PlaySession | null = null;

  const hex = (bytes: Uint8Array): string =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

  const readout = h('p', { class: 'status', id: 'pad-readout' });

  /** Publish input immediately after touch state changes. */
  const refresh = (): void => {
    session?.publish();
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
      // The zones sit on the stage and the toggle sits below it, so reaching the toggle can scroll
      // the stage out of the viewport, and a point outside the viewport hits nothing. Bring the
      // controls back into view; aligning their bottom also keeps them on a short landscape phone.
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
  // Where each frame's time goes, and the report the operator sends (web/src/play/report.ts).
  const reports = new ReportControls((text) => context.log(text));
  const play = h('button', { id: 'game-play', text: 'Play', onClick: () => {
    session?.stop();
    session = new PlaySession(canvas, controls, context.settings.controlStickDeadzone,
      (text) => { performance.textContent = text; }, (text) => context.log(text), reports.begin());
    void session.start(picker.files?.[0] ?? null);
  } });
  const stop = h('button', { id: 'game-stop', text: 'Stop', onClick: () => {
    session?.stop();
    session = null;
    performance.textContent = 'Stopped. Press Play to restart.';
  } });
  screen.append(h('div', { class: 'panel' }, [
    h('p', { text: 'Play loads the operator disc from the verified cache / server. You can also select a local ISO. Starts at the game menus; port 1 uses controller, touch or keyboard. Audio and online play are not connected yet. Leaving Game stops the session.' }),
    picker, h('div', { class: 'row' }, [play, stop]), performance, reports.element,
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
