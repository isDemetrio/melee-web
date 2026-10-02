import type { ScreenName } from '../types.js';
import { h, type AppContext } from './context.js';
import { lobbyScreen } from './screens/lobby.js';
import { gameScreen } from './screens/game.js';
import { settingsScreen } from './screens/settings.js';

/**
 * The shell: owns the screen container, the navigation bar and the diagnostic log.
 *
 * Screens are plain functions returning an element. They are re-rendered on navigation
 * rather than patched, because nothing here re-renders at frame rate; the game itself
 * lives on a canvas inside the game screen and is not managed by the DOM at all.
 */
export class Shell {
  private readonly root: HTMLElement;
  private readonly logLines: string[] = [];
  private readonly logElement: HTMLElement;
  private current: ScreenName = 'boot';
  private audioStatusText = 'audio: not started';
  private audioStatusElement: HTMLElement | null = null;

  constructor(private readonly context: AppContext) {
    this.root = document.getElementById('app') as HTMLElement;
    this.logElement = h('div', { class: 'log', id: 'diagnostic-log', 'aria-live': 'polite' });
    this.render();
  }

  navigate(screen: ScreenName): void {
    this.current = screen;
    this.root.dataset.screen = screen;
    this.render();
  }

  /**
   * The audio status lives in the header, not on a screen: the unlock happens in the same
   * gesture that navigates away from the boot screen, so a status rendered there would be
   * destroyed before anyone could read it.
   */
  setAudioStatus(text: string): void {
    this.audioStatusText = text;
    if (this.audioStatusElement) this.audioStatusElement.textContent = text;
  }

  log(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.logLines.push(`${stamp}  ${line}`);
    if (this.logLines.length > 200) this.logLines.shift();
    this.logElement.textContent = this.logLines.join('\n');
    this.logElement.scrollTop = this.logElement.scrollHeight;
  }

  private render(): void {
    this.root.replaceChildren();

    const audioStatus = h('span', {
      class: 'status',
      id: 'audio-status',
      text: this.audioStatusText,
    });
    this.audioStatusElement = audioStatus;

    this.root.append(
      h('header', { class: 'panel row row--between', style: 'margin:16px 28px 0' }, [
        h('h1', { text: 'Melee — private build' }),
        h('nav', { class: 'row' }, [
          h('button', { text: 'Boot', onClick: () => this.navigate('boot') }),
          h('button', { text: 'Lobby', onClick: () => this.navigate('lobby') }),
          h('button', { text: 'Settings', onClick: () => this.navigate('settings') }),
          h('button', { text: 'Game', onClick: () => this.navigate('game') }),
        ]),
        audioStatus,
      ]),
    );

    const body = h('main', { class: 'screen', 'data-active': 'true' });
    body.append(this.buildScreen(this.current));
    this.root.append(body);

    this.root.append(h('footer', { class: 'panel', style: 'margin:0 28px 16px' }, [this.logElement]));
    this.logElement.textContent = this.logLines.join('\n');
  }

  private buildScreen(screen: ScreenName): HTMLElement {
    switch (screen) {
      case 'settings':
        return settingsScreen(this.context);
      case 'lobby':
        return lobbyScreen(this.context);
      case 'game':
        return gameScreen(this.context);
      case 'boot':
      default:
        return bootScreen(this.context);
    }
  }
}

/**
 * Boot screen: capability report, the audio-unlocking gesture, and the truth about what
 * this build can currently do. It must never promise a game that is not there.
 */
function bootScreen(context: AppContext): HTMLElement {
  const screen = h('section', { id: 'screen-boot' });
  screen.append(h('h2', { text: 'Boot' }));

  const capabilities = context.capabilities;
  if (context.capabilitiesError !== null) {
    screen.append(h('p', { class: 'bad', text: `Capability detection failed: ${context.capabilitiesError}` }));
  } else if (capabilities === null) {
    screen.append(h('p', { text: 'Checking what this device supports…' }));
  } else {
    const rows: Array<[string, boolean]> = [
      ['WebGPU', capabilities.webgpu],
      ['Cross-origin isolation (COOP/COEP)', capabilities.crossOriginIsolated],
      ['SharedArrayBuffer', capabilities.sharedArrayBuffer],
      ['WebAssembly threads', capabilities.wasmThreads],
      ['WebAssembly exceptions', capabilities.wasmExceptions],
      ['AudioWorklet', capabilities.audioWorklet],
      ['OPFS', capabilities.opfs],
      ['Gamepad API', capabilities.gamepad],
      ['Screen Wake Lock', capabilities.wakeLock],
    ];
    screen.append(
      h('div', { class: 'panel' }, [
        h('h2', { text: 'This device' }),
        h(
          'ul',
          { class: 'checks', id: 'capability-list' },
          rows.map(([label, ok]) =>
            h('li', {}, [h('span', { class: `mark ${ok ? 'ok' : 'bad'}`, text: ok ? '✓' : '✗' }), label]),
          ),
        ),
      ]),
    );

    if (!capabilities.usable) {
      screen.append(
        h('p', {
          class: 'bad',
          text: `This build needs: ${capabilities.missing.join(', ')}. There is no WebGL2 fallback in v1.0 by design.`,
        }),
      );
    }
  }

  const play = h('button', {
    class: 'primary',
    id: 'play-button',
    text: 'Gioca',
    onClick: () => {
      void context.audio.unlock().then((status) => {
        context.setAudioStatus(
          `audio: ${status.state} @ ${status.sampleRate ?? '?'} Hz, worklet ${status.workletLoaded ? 'on' : 'off'}`,
        );
        context.log(`audio unlocked: ${status.state}, worklet ${status.workletLoaded}`);
        context.navigate('lobby');
      });
    },
  });

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Start' }),
      h('p', {
        text:
          'The button below unlocks audio (browsers only allow that after a gesture) and takes you to the lobby. ' +
          'The result is reported in the header, where it stays visible on every screen.',
      }),
      h('div', { class: 'row', style: 'margin-top:12px' }, [play]),
    ]),
  );

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Status of this build' }),
      h('p', {
        text:
          'Open Game for local play using the operator disc and the CI-built core. Controller, keyboard and touch drive port 1. Game audio and online matches are not connected.',
      }),
    ]),
  );

  return screen;
}
