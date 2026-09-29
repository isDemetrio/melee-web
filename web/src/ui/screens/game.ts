import { h, type AppContext } from '../context.js';

/**
 * Game screen.
 *
 * This screen is honest about the state of the project: the canvas, the touch overlay and
 * the performance readout are real, but there is no game core to draw yet. It says so on
 * screen rather than showing a placeholder that could be mistaken for progress.
 *
 * What is real here:
 *  - the canvas is sized to the GameCube aspect ratio (73:60) and the renderer will
 *    present into it (docs/SPEC_PIANO.md §1.3);
 *  - the touch overlay uses Pointer Events with `touch-action: none`, so there is no
 *    300 ms click delay, and it writes into the same PAD state the Gamepad API uses
 *    (§4.2) — the overlay is a fallback, not a separate input path;
 *  - the overlay opacity is a real setting.
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

  const overlay = h('div', { id: 'touch-overlay', 'data-enabled': 'false' }, [
    h('div', { class: 'stick-zone', id: 'stick-zone' }),
    h('div', { class: 'button-zone', id: 'button-zone' }),
  ]);
  document.body.append(overlay);

  const overlayToggle = h('input', {
    id: 'touch-overlay-toggle',
    type: 'checkbox',
    onchange: (event) => {
      const enabled = (event.target as HTMLInputElement).checked;
      overlay.dataset.enabled = String(enabled);
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
        text: 'A physical controller via the Gamepad API is the recommended way to play; the overlay is the fallback.',
      }),
      performance,
    ]),
  );

  // The overlay is removed from the document when this screen is replaced, so it does not
  // linger over other screens.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(screen)) {
      overlay.remove();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return screen;
}
