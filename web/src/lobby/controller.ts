import type { PeerId, RoomCode } from '../types.js';
import { generateRoomCode, normaliseRoomCode } from '../net/roomCode.js';
import type { SignalingChannel } from '../net/signaling.js';
import { MatchSession, type SessionState } from '../net/session.js';
import type { NetTransport, PeerConnectionFactory } from '../net/transport.js';

/**
 * Lobby controller: the one place that knows how a room behaves.
 *
 * Rules it enforces, from docs/SPEC_PIANO.md §3.3 and §3.4:
 *  - a room holds exactly two players for 1v1; a third joiner is rejected, not ignored;
 *  - the creator is the host and therefore port 1;
 *  - the match starts when the game data channel is open, never before.
 *
 * Everything is injected (signalling channel, peer connection factory), so the whole
 * thing is exercised in unit tests with no network and no browser.
 */

export type LobbyState =
  | 'idle'
  | 'joining'
  | 'waiting'
  | 'negotiating'
  | 'ready'
  | 'full'
  | 'closed'
  | 'error';

export interface LobbySnapshot {
  readonly state: LobbyState;
  readonly code: RoomCode | null;
  readonly role: 'host' | 'guest';
  readonly peers: readonly PeerId[];
  readonly error: string | null;
  readonly transport: NetTransport | null;
}

export interface LobbyOptions {
  readonly selfId: PeerId;
  readonly nickname: string;
  readonly signaling: SignalingChannel;
  readonly createPeerConnection: PeerConnectionFactory;
  readonly iceServers?: RTCIceServer[];
  readonly peerTimeoutMs?: number;
}

const MAX_PLAYERS = 2;

export class LobbyController {
  private state: LobbyState = 'idle';
  private code: RoomCode | null = null;
  private role: 'host' | 'guest' = 'host';
  private session: MatchSession | null = null;
  private transport: NetTransport | null = null;
  private error: string | null = null;
  private readonly handlers = new Set<(snapshot: LobbySnapshot) => void>();
  private unsubscribeSession: (() => void) | null = null;

  constructor(private readonly options: LobbyOptions) {}

  snapshot(): LobbySnapshot {
    return {
      state: this.state,
      code: this.code,
      role: this.role,
      peers: [...this.options.signaling.peers()],
      error: this.error,
      transport: this.transport,
    };
  }

  onChange(handler: (snapshot: LobbySnapshot) => void): () => void {
    this.handlers.add(handler);
    handler(this.snapshot());
    return () => this.handlers.delete(handler);
  }

  /** Create a room as the host. The code is generated locally. */
  async createRoom(): Promise<RoomCode> {
    const code = generateRoomCode();
    await this.enter(code, 'host');
    return code;
  }

  /** Join an existing room as the guest. Returns null when the code is malformed. */
  async joinRoom(rawCode: string): Promise<RoomCode | null> {
    const code = normaliseRoomCode(rawCode);
    if (code === null) {
      this.fail('That is not a valid room code (four letters, no I, O, L, S or 0).');
      return null;
    }
    await this.enter(code, 'guest');
    return code;
  }

  private async enter(code: RoomCode, role: 'host' | 'guest'): Promise<void> {
    this.code = code;
    this.role = role;
    this.error = null;
    this.setState('joining');

    this.options.signaling.onPresence((peers) => {
      const others = peers.filter((peer) => peer !== this.options.selfId);
      if (others.length + 1 > MAX_PLAYERS) {
        // 1v1 only. Slippi's netcode supports 2v2 as a mesh, not a four-way room.
        this.fail('This room is full (1v1 only).');
        return;
      }
      this.emit();
    });

    const session = new MatchSession({
      role,
      selfId: this.options.selfId,
      nickname: this.options.nickname,
      code,
      signaling: this.options.signaling,
      createPeerConnection: this.options.createPeerConnection,
      ...(this.options.iceServers ? { iceServers: this.options.iceServers } : {}),
      ...(this.options.peerTimeoutMs !== undefined ? { peerTimeoutMs: this.options.peerTimeoutMs } : {}),
    });
    this.session = session;

    this.unsubscribeSession = session.onStateChange((state) => this.onSessionState(state));
    this.setState('waiting');

    try {
      await session.start();
      void session.whenReady().then((transport) => {
        this.transport = transport;
        this.setState('ready');
      });
    } catch (cause) {
      this.fail(cause instanceof Error ? cause.message : 'Could not join the room.');
    }
  }

  /** Leave the room and tear the peer connection down. */
  async leave(): Promise<void> {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.session?.close();
    this.session = null;
    this.transport = null;
    await this.options.signaling.leave();
    this.setState('closed');
  }

  private onSessionState(state: SessionState): void {
    switch (state) {
      case 'negotiating':
      case 'connecting':
        this.setState('negotiating');
        return;
      case 'ready':
        this.setState('ready');
        return;
      case 'failed':
        this.fail('The connection to the other player failed.');
        return;
      case 'closed':
        this.setState('closed');
        return;
      default:
        this.emit();
    }
  }

  private fail(message: string): void {
    this.error = message;
    this.setState('error');
  }

  private setState(state: LobbyState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const handler of this.handlers) handler(snapshot);
  }
}
