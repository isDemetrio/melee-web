import { LobbyController, type LobbySnapshot } from '../../lobby/controller.js';
import { browserPeerConnection } from '../../net/browser-peer.js';
import { fetchIceServers, wireSignaling } from '../../net/lobby-wiring.js';
import { h, type AppContext } from '../context.js';
import { installTestHooks, shouldInstallTestHooks } from '../test-hooks.js';

/**
 * Lobby screen: nickname, create/join, presence, connection state.
 *
 * The screen is a thin renderer over LobbyController. All the behaviour that could be
 * wrong (role assignment, room-full rejection, readiness) lives in the controller, where
 * it is unit-tested without a browser.
 */
export function lobbyScreen(context: AppContext): HTMLElement {
  const screen = h('section', { id: 'screen-lobby' });
  screen.append(h('h2', { text: 'Lobby' }));

  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const wiring = wireSignaling(params, env, globalThis.localStorage, context.settings.nickname);

  if (wiring.signaling === null) {
    screen.append(
      h('div', { class: 'panel' }, [
        h('h2', { text: 'Lobby unavailable' }),
        h('p', { text: wiring.selection.unavailable ?? 'Signalling is not configured.' }),
        h('p', {
          class: 'muted',
          text:
            'Add ?signal=broadcast to the URL to open a second tab on this machine and play against yourself. ' +
            'That path needs no server and no credentials.',
        }),
      ]),
    );
    return screen;
  }

  const status = h('p', { class: 'status', id: 'lobby-status', text: 'idle' });
  const codeOut = h('div', { class: 'code', id: 'room-code', text: '----' });
  const presence = h('ul', { class: 'checks', id: 'lobby-presence' });
  const errorLine = h('p', { class: 'bad', id: 'lobby-error' });

  const controller = new LobbyController({
    selfId: wiring.selfId,
    nickname: context.settings.nickname,
    signaling: wiring.signaling,
    createPeerConnection: browserPeerConnection,
    peerTimeoutMs: 120_000,
  });

  // Only active with ?signal=broadcast. See src/ui/test-hooks.ts for why it exists and
  // what it deliberately does not expose.
  if (shouldInstallTestHooks(params)) installTestHooks(controller);

  const render = (snapshot: LobbySnapshot): void => {
    status.textContent = `${snapshot.state}${snapshot.role === 'host' ? ' (host, port 1)' : ' (guest, port 2)'}`;
    if (snapshot.code !== null) codeOut.textContent = snapshot.code;
    errorLine.textContent = snapshot.error ?? '';
    presence.replaceChildren(
      ...snapshot.peers.map((peer) =>
        h('li', {}, [
          h('span', { class: 'mark ok', text: '●' }),
          `${peer === wiring.selfId ? 'you' : 'peer'} ${peer.slice(0, 8)}`,
        ]),
      ),
    );
    const stats = snapshot.transport?.stats();
    if (stats) {
      context.log(
        `transport: sent ${stats.packetsSent} / recv ${stats.packetsReceived} packets, rtt ${stats.rttMs ?? 'n/a'} ms`,
      );
    }
  };

  const unsubscribe = controller.onChange(render);
  // Detach when the screen is replaced: the shell rebuilds screens on navigation.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(screen)) {
      unsubscribe();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const nicknameInput = h('input', {
    id: 'nickname',
    placeholder: 'nickname',
    value: context.settings.nickname,
    maxlength: '24',
    oninput: (event) => {
      const value = (event.target as HTMLInputElement).value;
      context.updateSettings({ nickname: value });
    },
  });

  const createButton = h('button', {
    class: 'primary',
    id: 'create-room',
    text: 'Create room',
    onClick: () => {
      void controller.createRoom().then((code) => context.log(`room created: ${code}`));
    },
  });

  const joinInput = h('input', {
    id: 'join-code',
    placeholder: 'ABCD',
    maxlength: '7',
    autocapitalize: 'characters',
  });
  const joinButton = h('button', {
    id: 'join-room',
    text: 'Join',
    onClick: () => {
      void controller.joinRoom((joinInput as HTMLInputElement).value).then((code) => {
        if (code) context.log(`joining room ${code}`);
      });
    },
  });

  const leaveButton = h('button', {
    id: 'leave-room',
    text: 'Leave',
    onClick: () => {
      void controller.leave().then(() => context.log('left the room'));
    },
  });

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Your name' }),
      h('div', { class: 'row' }, [nicknameInput]),
      h('p', {
        class: 'muted',
        text: 'Identity is local to this browser. Access to the site itself is already gated by Cloudflare Access.',
      }),
    ]),
  );

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Room' }),
      h('div', { class: 'row' }, [createButton, h('span', { class: 'muted', text: 'or' }), joinInput, joinButton, leaveButton]),
      h('div', { class: 'row', style: 'margin-top:12px' }, [h('span', { class: 'muted', text: 'code:' }), codeOut]),
      status,
      errorLine,
      h('h2', { style: 'margin-top:16px', text: 'In the room' }),
      presence,
    ]),
  );

  screen.append(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'Relay (TURN)' }),
      h('p', {
        id: 'turn-status',
        text: 'Not requested yet. TURN is needed on mobile and corporate networks where the two browsers cannot reach each other directly.',
      }),
      h('button', {
        id: 'check-turn',
        text: 'Check relay credentials',
        onClick: () => {
          void fetchIceServers().then((result) => {
            const element = screen.querySelector('#turn-status');
            if (element) {
              element.textContent = result.error ?? `Relay available: ${result.iceServers.length} ICE server entries.`;
              element.className = result.error ? 'bad' : 'ok';
            }
            context.log(result.error ?? 'turn credentials fetched');
          });
        },
      }),
    ]),
  );

  return screen;
}
