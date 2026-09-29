import { h, type AppContext } from '../context.js';
import type { Settings } from '../settings.js';

/**
 * Settings screen: every field of the settings schema, editable, persisted on change.
 *
 * Kept explicit rather than generated from the schema: the labels, the bounds and the
 * units are user-facing text and belong where a human can read and fix them.
 */
export function settingsScreen(context: AppContext): HTMLElement {
  const screen = h('section', { id: 'screen-settings' });
  screen.append(h('h2', { text: 'Settings' }));

  /** A range input with a live numeric readout. */
  const slider = (
    label: string,
    key: 'volume' | 'musicVolume',
    min: number,
    max: number,
    step: number,
  ): HTMLElement => {
    const readout = h('span', { class: 'status', id: `setting-${key}-value`, text: format(context.settings[key]) });
    const input = h('input', {
      type: 'range',
      id: `setting-${key}`,
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(context.settings[key]),
      oninput: (event) => {
        const next = Number((event.target as HTMLInputElement).value);
        readout.textContent = format(next);
        context.updateSettings({ [key]: next } as Partial<Settings>);
      },
    });
    return h('label', { class: 'row row--between' }, [h('span', { text: label }), h('span', { class: 'row' }, [input, readout])]);
  };

  const checkbox = (label: string, key: 'widescreen' | 'showPerformance'): HTMLElement =>
    h('label', { class: 'row row--between' }, [
      h('span', { text: label }),
      h('input', {
        type: 'checkbox',
        id: `setting-${key}`,
        ...(context.settings[key] ? { checked: true } : {}),
        onchange: (event) => {
          const checked = (event.target as HTMLInputElement).checked;
          context.updateSettings({ [key]: checked } as Partial<Settings>);
        },
      }),
    ]);

  const number = (
    label: string,
    key: 'inputDelayFrames' | 'internalScale' | 'controlStickDeadzone',
    min: number,
    max: number,
    step: number,
  ): HTMLElement =>
    h('label', { class: 'row row--between' }, [
      h('span', { text: label }),
      h('input', {
        type: 'number',
        id: `setting-${key}`,
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(context.settings[key]),
        onchange: (event) => {
          const next = Number((event.target as HTMLInputElement).value);
          context.updateSettings({ [key]: next } as Partial<Settings>);
          // Re-read from the context so the clamping in the schema is visible immediately.
          (event.target as HTMLInputElement).value = String(context.settings[key]);
        },
      }),
    ]);

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Audio' }),
      slider('Volume', 'volume', 0, 1, 0.05),
      slider('Music', 'musicVolume', 0, 1, 0.05),
    ]),
  );

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Video' }),
      number('Internal resolution scale', 'internalScale', 1, 4, 1),
      checkbox('Widescreen 16:9', 'widescreen'),
    ]),
  );

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Input and diagnostics' }),
      // Slippi's default is 2 frames; the specification allows 1 to 4 (docs/SPEC_PIANO.md §3.4).
      number('Input delay (frames)', 'inputDelayFrames', 1, 4, 1),
      number('Control stick deadzone', 'controlStickDeadzone', 0, 0.9, 0.05),
      checkbox('Show performance', 'showPerformance'),
    ]),
  );

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Where settings live' }),
      h('p', {
        text:
          'localStorage on this browser only, under the key melee-web.settings, with a schema version so a future change migrates your values instead of resetting them.',
      }),
    ]),
  );

  return screen;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
