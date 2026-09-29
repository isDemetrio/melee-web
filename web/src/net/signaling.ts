import type { PeerId, RoomCode, SignalMessage } from '../types.js';

/**
 * A signalling channel is a small message bus with presence. Two implementations
 * exist: Supabase Realtime (production) and a local WebSocket relay (development and
 * end-to-end tests). Tests use an in-memory implementation.
 *
 * Everything above this interface is transport-agnostic on purpose: the signalling
 * channel is only used to exchange SDP and ICE candidates. Once the WebRTC data
 * channel is open, signalling carries chat and room state and nothing that affects
 * the simulation.
 */
export interface SignalingChannel {
  /** Join a room. Resolves once the local peer is visible to the room. */
  join(code: RoomCode): Promise<void>;
  /** Current members, including self. */
  peers(): readonly PeerId[];
  /** Send a signal message to one peer. Fire and forget, never reliable. */
  send(to: PeerId, message: SignalMessage): void;
  /** Broadcast to every other member. */
  broadcast(message: SignalMessage): void;
  onMessage(handler: (from: PeerId, message: SignalMessage) => void): () => void;
  onPresence(handler: (peers: readonly PeerId[]) => void): () => void;
  leave(): Promise<void>;
}

export interface SignalingOptions {
  /** Identity of this peer. Stable for the lifetime of the page. */
  readonly selfId: PeerId;
  readonly nickname: string;
}

/** A channel plus its local bus, for tests that need to observe or drive it directly. */
export interface TestableChannel extends SignalingChannel {
  readonly bus: SignalBus;
}

/** A channel that the hub can push inbound traffic into. */
interface InboundChannel extends SignalingChannel {
  receive(from: PeerId, message: SignalMessage): void;
  presence(peers: readonly PeerId[]): void;
}

/** Tiny emitter with unsubscribe, used by every channel implementation. */
export class SignalBus {
  private readonly messageHandlers = new Set<(from: PeerId, message: SignalMessage) => void>();
  private readonly presenceHandlers = new Set<(peers: readonly PeerId[]) => void>();

  onMessage(handler: (from: PeerId, message: SignalMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onPresence(handler: (peers: readonly PeerId[]) => void): () => void {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  emitMessage(from: PeerId, message: SignalMessage): void {
    for (const handler of this.messageHandlers) handler(from, message);
  }

  emitPresence(peers: readonly PeerId[]): void {
    for (const handler of this.presenceHandlers) handler(peers);
  }

  clear(): void {
    this.messageHandlers.clear();
    this.presenceHandlers.clear();
  }
}

/**
 * In-memory bus shared by N channels. Used by unit tests to exercise the whole
 * handshake without a network. Presence is computed from the joined set, so a test
 * that joins two channels sees both peers exactly as Supabase would report them.
 */
export class InMemorySignalingHub {
  private readonly members = new Map<RoomCode, Map<PeerId, InboundChannel>>();

  create(options: SignalingOptions): TestableChannel {
    return new InMemorySignalingChannel(this, options);
  }

  addMember(code: RoomCode, peerId: PeerId, channel: InboundChannel): void {
    let room = this.members.get(code);
    if (!room) {
      room = new Map();
      this.members.set(code, room);
    }
    room.set(peerId, channel);
    this.publishPresence(code);
  }

  removeMember(code: RoomCode, peerId: PeerId): void {
    this.members.get(code)?.delete(peerId);
    this.publishPresence(code);
  }

  peers(code: RoomCode): PeerId[] {
    return [...(this.members.get(code)?.keys() ?? [])];
  }

  deliver(code: RoomCode, from: PeerId, to: PeerId, message: SignalMessage): void {
    this.members.get(code)?.get(to)?.receive(from, message);
  }

  private publishPresence(code: RoomCode): void {
    const ids = this.peers(code);
    for (const channel of this.members.get(code)?.values() ?? []) {
      channel.presence(ids);
    }
  }
}

class InMemorySignalingChannel implements InboundChannel {
  readonly bus = new SignalBus();
  private code: RoomCode | null = null;

  constructor(
    private readonly hub: InMemorySignalingHub,
    private readonly options: SignalingOptions,
  ) {}

  async join(code: RoomCode): Promise<void> {
    this.code = code;
    this.hub.addMember(code, this.options.selfId, this);
  }

  peers(): readonly PeerId[] {
    return this.code ? this.hub.peers(this.code) : [];
  }

  send(to: PeerId, message: SignalMessage): void {
    if (!this.code) throw new Error('signaling: send before join');
    this.hub.deliver(this.code, this.options.selfId, to, message);
  }

  broadcast(message: SignalMessage): void {
    if (!this.code) throw new Error('signaling: broadcast before join');
    for (const peer of this.peers()) {
      if (peer !== this.options.selfId) this.hub.deliver(this.code, this.options.selfId, peer, message);
    }
  }

  onMessage(handler: (from: PeerId, message: SignalMessage) => void): () => void {
    return this.bus.onMessage(handler);
  }

  onPresence(handler: (peers: readonly PeerId[]) => void): () => void {
    return this.bus.onPresence(handler);
  }

  async leave(): Promise<void> {
    if (this.code) this.hub.removeMember(this.code, this.options.selfId);
    this.bus.clear();
    this.code = null;
  }

  /** Called by the hub. Not part of the public interface. */
  receive(from: PeerId, message: SignalMessage): void {
    this.bus.emitMessage(from, message);
  }

  /** Called by the hub. Not part of the public interface. */
  presence(peers: readonly PeerId[]): void {
    this.bus.emitPresence(peers);
  }
}
