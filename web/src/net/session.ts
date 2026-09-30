import type { PeerId, PeerRole, RoomCode, SignalMessage } from '../types.js';
import type { SignalingChannel } from './signaling.js';
import {
  defaultRtcConfiguration,
  type IceCandidateLike,
  type NetTransport,
  type PeerConnectionFactory,
  type PeerConnectionLike,
} from './transport.js';
import { WebRtcTransport } from './webrtc.js';

export type SessionState =
  | 'idle'
  | 'signalling'
  | 'waiting-for-peer'
  | 'negotiating'
  | 'connecting'
  | 'ready'
  | 'failed'
  | 'closed';

export interface MatchSessionOptions {
  readonly role: PeerRole;
  readonly selfId: PeerId;
  readonly nickname: string;
  readonly code: RoomCode;
  readonly signaling: SignalingChannel;
  readonly createPeerConnection: PeerConnectionFactory;
  readonly iceServers?: RTCIceServer[];
  /** Give up waiting for the other player after this long. 0 disables the timeout. */
  readonly peerTimeoutMs?: number;
}

/**
 * Brings one room from "two browsers are in a lobby" to "a data channel is open".
 *
 * The host is the impolite peer: it creates the offer and never yields. The guest is
 * polite: it answers whatever offer it receives. Roles are fixed by the room, not
 * negotiated, because the in-game port assignment depends on them: the host is port 1.
 *
 * Everything about this class is deliberately observable and injectable: the tests run
 * a full host/guest handshake in Node against a fake RTCPeerConnection, so a regression
 * in the negotiation logic fails in CI instead of in a match.
 */
export class MatchSession {
  private currentState: SessionState = 'idle';
  private transport: WebRtcTransport | null = null;
  private connection: PeerConnectionLike | null = null;
  private remoteId: PeerId | null = null;
  private readonly pendingCandidates: IceCandidateLike[] = [];
  private remoteDescriptionSet = false;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly stateHandlers = new Set<(state: SessionState) => void>();
  private readyResolve: ((transport: NetTransport) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private peerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: MatchSessionOptions) {}

  get state(): SessionState {
    return this.currentState;
  }

  get peerId(): PeerId | null {
    return this.remoteId;
  }

  get currentTransport(): NetTransport | null {
    return this.transport;
  }

  onStateChange(handler: (state: SessionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Resolves with the open transport, or rejects on failure or peer timeout. */
  whenReady(): Promise<NetTransport> {
    return new Promise<NetTransport>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      if (this.currentState === 'ready' && this.transport) resolve(this.transport);
    });
  }

  async start(): Promise<void> {
    const { signaling, code } = this.options;
    this.setState('signalling');

    this.unsubscribers.push(
      signaling.onMessage((from, message) => {
        // handleSignal is async (it awaits SDP operations). An unawaited rejection here
        // would surface as an unhandled error rather than a session failure.
        void this.handleSignal(from, message).catch((cause: unknown) => {
          this.fail(cause instanceof Error ? cause : new Error('signalling failed'));
        });
      }),
      signaling.onPresence((peers) => this.handlePresence(peers)),
    );

    await signaling.join(code);
    this.setState('waiting-for-peer');

    const timeout = this.options.peerTimeoutMs ?? 0;
    if (timeout > 0) {
      this.peerTimer = setTimeout(() => {
        if (this.currentState === 'waiting-for-peer') {
          this.fail(new Error(`no peer joined room ${code} within ${timeout} ms`));
        }
      }, timeout);
    }

    // A peer may already be in the room when we join; presence fires on join in every
    // implementation, but check once anyway so a lost presence event cannot strand us.
    this.handlePresence(signaling.peers());
  }

  close(): void {
    this.clearPeerTimer();
    try {
      this.options.signaling.broadcast({ kind: 'bye' });
    } catch {
      // Leaving a room that is already gone is not an error worth surfacing.
    }
    this.transport?.close();
    this.connection?.close();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    void this.options.signaling.leave();
    this.setState('closed');
  }

  private handlePresence(peers: readonly PeerId[]): void {
    const others = peers.filter((peer) => peer !== this.options.selfId);
    const first = others[0];
    if (first === undefined) return;

    if (this.options.role === 'host' && this.currentState === 'waiting-for-peer') {
      this.remoteId = first;
      this.clearPeerTimer();
      void this.negotiateAsHost().catch((cause: unknown) => {
        this.fail(cause instanceof Error ? cause : new Error('negotiation failed'));
      });
    }
    if (this.options.role === 'guest' && this.remoteId === null) {
      // Remember who is here so a candidate arriving before the offer has a destination.
      this.remoteId = first;
    }
  }

  private async handleSignal(from: PeerId, message: SignalMessage): Promise<void> {
    if (message.kind === 'bye') {
      this.setState('closed');
      return;
    }
    if (this.options.role === 'host' && from !== this.remoteId) return;
    if (this.options.role === 'guest' && this.remoteId === null) this.remoteId = from;

    switch (message.kind) {
      case 'hello':
        return;
      case 'offer': {
        if (this.options.role !== 'guest') return;
        this.remoteId = from;
        this.clearPeerTimer();
        await this.acceptOffer(message.sdp);
        return;
      }
      case 'answer': {
        if (this.options.role !== 'host' || !this.connection) return;
        await this.connection.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
        return;
      }
      case 'candidate': {
        const candidate: IceCandidateLike = {
          candidate: message.candidate,
          sdpMid: message.sdpMid,
          sdpMLineIndex: message.sdpMLineIndex,
        };
        if (!this.remoteDescriptionSet) {
          // ICE can beat the SDP through the signalling service. Dropping these
          // candidates is the classic cause of "connects on Wi-Fi, fails on 4G".
          this.pendingCandidates.push(candidate);
          return;
        }
        await this.connection?.addIceCandidate(candidate);
        return;
      }
      default:
        return;
    }
  }

  private async negotiateAsHost(): Promise<void> {
    this.setState('negotiating');
    const connection = this.createConnection();
    // Only the host opens channels; the guest receives them through ondatachannel.
    this.transport?.open();

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (offer.sdp) this.sendToPeer({ kind: 'offer', sdp: offer.sdp });
  }

  private async acceptOffer(sdp: string): Promise<void> {
    this.setState('negotiating');
    const connection = this.connection ?? this.createConnection();
    await connection.setRemoteDescription({ type: 'offer', sdp });
    this.remoteDescriptionSet = true;
    await this.flushCandidates();

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (answer.sdp) this.sendToPeer({ kind: 'answer', sdp: answer.sdp });
  }

  private createConnection(): PeerConnectionLike {
    const iceServers = this.options.iceServers ?? [];
    const connection = this.options.createPeerConnection(defaultRtcConfiguration(iceServers));
    connection.onicecandidate = (event) => {
      if (!event.candidate?.candidate) return;
      this.sendToPeer({
        kind: 'candidate',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
      });
    };
    this.connection = connection;
    // Both roles need a transport object from the start: the host opens the channels
    // itself, the guest learns about them from ondatachannel, and both need the state
    // machine that turns "game channel open" into "match ready".
    this.attachTransport(new WebRtcTransport(connection));
    return connection;
  }

  private attachTransport(transport: WebRtcTransport): void {
    this.transport = transport;
    transport.onStateChange((state) => {
      if (state === 'connected') this.markReady(transport);
      else if (state === 'failed') this.fail(new Error('WebRTC connection failed'));
      else if (state === 'connecting') this.setState('connecting');
    });
  }

  private async flushCandidates(): Promise<void> {
    if (!this.connection) return;
    const queued = this.pendingCandidates.splice(0, this.pendingCandidates.length);
    for (const candidate of queued) {
      await this.connection.addIceCandidate(candidate);
    }
  }

  private sendToPeer(message: SignalMessage): void {
    if (!this.remoteId || this.currentState === 'closed') return;
    try {
      this.options.signaling.send(this.remoteId, message);
    } catch (cause: unknown) {
      // A signalling send can fail because the room was left underneath us. That is not
      // an unhandled rejection: while the session is live, losing the message means
      // negotiation cannot complete, so it is reported as a failure.
      this.fail(cause instanceof Error ? cause : new Error('signalling send failed'));
    }
  }

  private markReady(transport: WebRtcTransport): void {
    this.clearPeerTimer();
    this.setState('ready');
    this.readyResolve?.(transport);
    this.readyResolve = null;
    this.readyReject = null;
  }

  private fail(error: Error): void {
    this.clearPeerTimer();
    this.setState('failed');
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
  }

  private clearPeerTimer(): void {
    if (this.peerTimer !== null) {
      clearTimeout(this.peerTimer);
      this.peerTimer = null;
    }
  }

  private setState(state: SessionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}
