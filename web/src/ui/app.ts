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

  log(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.logLines.push(`${stamp}  ${line}`);
    if (this.logLines.length > 200) this.logLines.shift();
    this.logElement.textContent = this.logLines.join('\n');
    this.logElement.scrollTop = this.logElement.scrollHeight;
  }

  private render(): void {
    this.root.replaceChildren();

    this.root.append(
      h('header', { class: 'panel row row--between', style: 'margin:16px 28px 0' }, [
        h('h1', { text: 'Melee — private build' }),
        h('nav', { class: 'row' }, [
          h('button', { text: 'Boot', onClick: () => this.navigate('boot') }),
          h('button', { text: 'Lobby', onClick: () => this.navigate('lobby') }),
          h('button', { text: 'Settings', onClick: () => this.navigate('settings') }),
          h('button', { text: 'Game', onClick: () => this.navigate('game') }),
        ]),
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

  const audioStatus = h('span', { class: 'status', id: 'audio-status', text: 'audio: not started' });
  const play = h('button', {
    class: 'primary',
    id: 'play-button',
    text: 'Gioca',
    onClick: () => {
      void context.audio.unlock().then((status) => {
        audioStatus.textContent = `audio: ${status.state} @ ${status.sampleRate ?? '?'} Hz, worklet ${status.workletLoaded ? 'on' : 'off'}`;
        context.log(`audio unlocked: ${status.state}, worklet ${status.workletLoaded}`);
        context.navigate('lobby');
      });
    },
  });

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Start' }),
      h('p', {
        text: 'The button below unlocks audio (browsers only allow that after a gesture) and takes you to the lobby.',
      }),
      h('div', { class: 'row', style: 'margin-top:12px' }, [play, audioStatus]),
    ]),
  );

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Status of this build' }),
      h('p', {
        text:
          'The web shell, the lobby and the WebRTC transport are implemented. The game core (melee.wasm) is not built yet: it needs the disc, and the build runs in CI. The Game tab says so plainly instead of showing a fake screen.',
      }),
    ]),
  );

  return screen;
}
