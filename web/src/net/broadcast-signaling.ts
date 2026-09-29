import type { PeerId, RoomCode, SignalMessage } from '../types.js';
import { SignalBus, type SignalingChannel, type SignalingOptions } from './signaling.js';

/**
 * Signalling over `BroadcastChannel`, for two tabs on the same machine.
 *
 * This exists for two reasons and neither of them is production:
 *  - it makes the whole negotiation path testable in a real browser (Playwright) without
 *    any server, credentials or network, so a regression in SDP/ICE handling fails in CI;
 *  - it is a useful manual debugging path: two tabs on the same origin can play each
 *    other with the lobby disabled.
 *
 * It is deliberately NOT a security boundary. BroadcastChannel is same-origin only, so it
 * cannot reach another machine, and it carries signalling only: the match traffic still
 * goes over WebRTC.
 */

const CHANNEL_PREFIX = 'melee-web.signal.';

type Wire =
  | { readonly kind: 'signal'; readonly from: PeerId; readonly to: PeerId; readonly message: SignalMessage }
  | { readonly kind: 'presence-request'; readonly from: PeerId }
  | { readonly kind: 'presence-announce'; readonly from: PeerId };

export class BroadcastSignalingChannel implements SignalingChannel {
  private readonly bus = new SignalBus();
  private readonly members = new Set<PeerId>();
  private channel: BroadcastChannel | null = null;

  constructor(private readonly options: SignalingOptions) {}

  async join(code: RoomCode): Promise<void> {
    this.members.add(this.options.selfId);
    this.channel = new BroadcastChannel(CHANNEL_PREFIX + code);
    this.channel.onmessage = (event: MessageEvent<unknown>) => this.onWire(event.data);
    this.announcePresence();
    this.publishPresence();
  }

  peers(): readonly PeerId[] {
    return [...this.members];
  }

  send(to: PeerId, message: SignalMessage): void {
    this.post({ kind: 'signal', from: this.options.selfId, to, message });
  }

  broadcast(message: SignalMessage): void {
    for (const peer of this.members) {
      if (peer !== this.options.selfId) this.send(peer, message);
    }
  }

  onMessage(handler: (from: PeerId, message: SignalMessage) => void): () => void {
    return this.bus.onMessage(handler);
  }

  onPresence(handler: (peers: readonly PeerId[]) => void): () => void {
    return this.bus.onPresence(handler);
  }

  async leave(): Promise<void> {
    this.channel?.close();
    this.channel = null;
    this.members.clear();
    this.bus.clear();
  }

  private post(wire: Wire): void {
    this.channel?.postMessage(wire);
  }

  private announcePresence(): void {
    this.post({ kind: 'presence-request', from: this.options.selfId });
  }

  private onWire(raw: unknown): void {
    const wire = raw as Wire;
    if (typeof wire !== 'object' || wire === null || !('kind' in wire)) return;
    if (wire.from === this.options.selfId) return;

    switch (wire.kind) {
      case 'presence-request':
        this.members.add(wire.from);
        // Answer so the newcomer learns about us without waiting for the next event.
        this.post({ kind: 'presence-announce', from: this.options.selfId });
        this.publishPresence();
        return;
      case 'presence-announce':
        this.members.add(wire.from);
        this.publishPresence();
        return;
      case 'signal':
        if (wire.to !== this.options.selfId) return;
        this.bus.emitMessage(wire.from, wire.message);
        return;
      default:
        return;
    }
  }

  private publishPresence(): void {
    this.bus.emitPresence([...this.members]);
  }
}
