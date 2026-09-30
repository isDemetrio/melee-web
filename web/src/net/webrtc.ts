import type { Packet, TransportState, TransportStats } from '../types.js';
import {
  CONTROL_CHANNEL_INIT,
  CONTROL_CHANNEL_LABEL,
  GAME_CHANNEL_INIT,
  GAME_CHANNEL_LABEL,
  toPacket,
  type DataChannelLike,
  type NetTransport,
  type PeerConnectionLike,
} from './transport.js';

interface ChannelHandlers {
  onPacket: Set<(packet: Packet, reliable: boolean) => void>;
  onStateChange: Set<(state: TransportState) => void>;
}

/**
 * The unreliable data path, implemented over two WebRTC data channels.
 *
 * Why two channels rather than one: WebRTC reliability is per-channel, not
 * per-message. The guest input stream must be allowed to drop packets, while the
 * handshake and character-selection messages must not be lost. Mixing them on one
 * reliable channel would head-of-line block the input stream behind a retransmission.
 */
export class WebRtcTransport implements NetTransport {
  private gameChannel: DataChannelLike | null = null;
  private controlChannel: DataChannelLike | null = null;
  private currentState: TransportState = 'idle';
  private readonly handlers: ChannelHandlers = {
    onPacket: new Set(),
    onStateChange: new Set(),
  };
  private counters = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 };
  private lastRtt: number | null = null;

  constructor(private readonly connection: PeerConnectionLike) {
    connection.onconnectionstatechange = () => this.syncConnectionState();
    connection.ondatachannel = (event) => this.attachChannel(event.channel);
  }

  /** Host side: create both channels. Must be called before the offer is created. */
  open(): void {
    this.attachChannel(this.connection.createDataChannel(GAME_CHANNEL_LABEL, GAME_CHANNEL_INIT));
    this.attachChannel(this.connection.createDataChannel(CONTROL_CHANNEL_LABEL, CONTROL_CHANNEL_INIT));
  }

  get state(): TransportState {
    return this.currentState;
  }

  send(packet: Packet): void {
    this.write(this.gameChannel, packet);
  }

  sendReliable(packet: Packet): void {
    this.write(this.controlChannel, packet);
  }

  onPacket(handler: (packet: Packet, reliable: boolean) => void): () => void {
    this.handlers.onPacket.add(handler);
    return () => this.handlers.onPacket.delete(handler);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.handlers.onStateChange.add(handler);
    return () => this.handlers.onStateChange.delete(handler);
  }

  stats(): TransportStats {
    return {
      rttMs: this.lastRtt,
      packetsSent: this.counters.sent,
      packetsReceived: this.counters.received,
      bytesSent: this.counters.bytesSent,
      bytesReceived: this.counters.bytesReceived,
    };
  }

  close(): void {
    this.gameChannel?.close();
    this.controlChannel?.close();
    this.gameChannel = null;
    this.controlChannel = null;
    this.setState('closed');
  }

  /**
   * Record an RTT sample. The value comes from the netcode's own time sync or from
   * the control channel's ping, never from getStats(): the browser's own estimate is
   * smoothed over a different window than the netcode cares about.
   */
  recordRtt(milliseconds: number): void {
    this.lastRtt = milliseconds;
  }

  private write(channel: DataChannelLike | null, packet: Packet): void {
    if (!channel || channel.readyState !== 'open') {
      // Never throw and never queue: the netcode handles loss, and a queue here would
      // silently add latency that rollback then has to fight.
      return;
    }
    channel.send(packet);
    this.counters.sent += 1;
    this.counters.bytesSent += packet.byteLength;
  }

  private attachChannel(channel: DataChannelLike): void {
    channel.binaryType = 'arraybuffer';
    if (channel.label === GAME_CHANNEL_LABEL) this.gameChannel = channel;
    else if (channel.label === CONTROL_CHANNEL_LABEL) this.controlChannel = channel;

    channel.onmessage = (event) => {
      const packet = toPacket(event.data);
      if (!packet) return;
      const reliable = channel.label === CONTROL_CHANNEL_LABEL;
      this.counters.received += 1;
      this.counters.bytesReceived += packet.byteLength;
      for (const handler of this.handlers.onPacket) handler(packet, reliable);
    };
    channel.onopen = () => this.syncConnectionState();
    channel.onclose = () => this.syncConnectionState();
  }

  /**
   * The transport is "connected" only when the game channel is open, not when ICE
   * finishes: the control channel opens first on some stacks, and starting a match
   * before the input path exists would desync on frame 1.
   */
  private syncConnectionState(): void {
    const ice = this.connection.connectionState;
    if (ice === 'failed') return this.setState('failed');
    if (ice === 'closed') return this.setState('closed');
    if (this.gameChannel?.readyState === 'open') return this.setState('connected');
    if (ice === 'connecting' || ice === 'new' || this.controlChannel?.readyState === 'open') {
      return this.setState('connecting');
    }
    return this.setState('idle');
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const handler of this.handlers.onStateChange) handler(state);
  }
}
