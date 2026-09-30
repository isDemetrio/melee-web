import type { LobbyController } from '../lobby/controller.js';

/**
 * Test hooks for the browser end-to-end tests.
 *
 * Scope, deliberately narrow: this is installed ONLY when the URL carries
 * `?signal=broadcast`, which is also the only configuration in which the lobby talks to
 * another tab instead of Supabase. Without that parameter nothing is exposed at all.
 *
 * What it is for: the Playwright tests must drive a real handshake between two real
 * Chromium tabs and then move real bytes over a real RTCPeerConnection. Doing that through
 * DOM clicks alone is not possible — the interesting assertions (transport ready, packets
 * received) are below the UI.
 *
 * What it is not: a backdoor. BroadcastChannel is same-origin, so a page carrying this hook
 * cannot reach another machine; and the hook exposes only the lobby controller, which
 * carries no credentials.
 */

export interface TestHooks {
  state(): string;
  code(): string | null;
  role(): string;
  peers(): readonly string[];
  createRoom(): Promise<string>;
  joinRoom(code: string): Promise<string | null>;
  /** Send a packet over the unreliable channel. Returns false when not connected. */
  send(bytes: number[]): boolean;
  /** Send a packet over the reliable channel. Returns false when not connected. */
  sendReliable(bytes: number[]): boolean;
  /** Everything received so far, oldest first. */
  received(): number[][];
  /** Drop the recorded packets. */
  clear(): void;
}

export const TEST_HOOK_PARAM = 'signal';
export const TEST_HOOK_VALUE = 'broadcast';
export const TEST_HOOK_GLOBAL = '__meleeLobby';

export function shouldInstallTestHooks(params: URLSearchParams): boolean {
  return params.get(TEST_HOOK_PARAM) === TEST_HOOK_VALUE;
}

export function installTestHooks(controller: LobbyController): void {
  const inbox: number[][] = [];

  const attach = (): void => {
    const transport = controller.snapshot().transport;
    if (!transport) return;
    transport.onPacket((packet) => inbox.push([...packet]));
  };
  controller.onChange(() => attach());
  attach();

  const hooks: TestHooks = {
    state: () => controller.snapshot().state,
    code: () => controller.snapshot().code,
    role: () => controller.snapshot().role,
    peers: () => controller.snapshot().peers,
    createRoom: () => controller.createRoom(),
    joinRoom: (code) => controller.joinRoom(code),
    send: (bytes) => {
      const transport = controller.snapshot().transport;
      if (!transport || transport.state !== 'connected') return false;
      transport.send(new Uint8Array(bytes));
      return true;
    },
    sendReliable: (bytes) => {
      const transport = controller.snapshot().transport;
      if (!transport || transport.state !== 'connected') return false;
      transport.sendReliable(new Uint8Array(bytes));
      return true;
    },
    received: () => inbox,
    clear: () => {
      inbox.length = 0;
    },
  };

  (globalThis as unknown as Record<string, unknown>)[TEST_HOOK_GLOBAL] = hooks;
}
