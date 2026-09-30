import type { Packet, TransportState, TransportStats } from '../types.js';

/**
 * The transport the Slippi netcode is written against.
 *
 * The native build uses ENet over UDP. The browser uses WebRTC data channels. The
 * netcode itself must not be able to tell the difference, so this interface mirrors
 * exactly what the netcode needs and nothing more:
 *
 *  - an unreliable, unordered path (the per-frame guest input packets),
 *  - a reliable, ordered path (handshake and character-selection messages),
 *  - a round-trip estimate for the time-sync logic,
 *  - no blocking calls, because the simulation must never wait on the network.
 *
 * Packets are opaque byte strings. They are never parsed, re-framed or re-ordered by
 * the transport: the Slippi packet format is the wire format.
 */
export interface NetTransport {
  readonly state: TransportState;
  /** Unreliable, unordered. Dropped packets are normal and the netcode expects it. */
  send(packet: Packet): void;
  /** Reliable, ordered. Used for the few messages that must not be lost. */
  sendReliable(packet: Packet): void;
  onPacket(handler: (packet: Packet, reliable: boolean) => void): () => void;
  onStateChange(handler: (state: TransportState) => void): () => void;
  stats(): TransportStats;
  close(): void;
}

/**
 * The subset of RTCPeerConnection this project uses. Declaring it explicitly lets the
 * unit tests drive a complete handshake against a fake implementation, in Node, with
 * no browser and no network.
 */
export interface DataChannelLike {
  readonly label: string;
  binaryType: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export interface SessionDescriptionLike {
  readonly type: string;
  readonly sdp?: string;
}

export interface IceCandidateLike {
  readonly candidate?: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}

export interface PeerConnectionLike {
  readonly connectionState: string;
  createDataChannel(label: string, init?: RTCDataChannelInit): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  getStats(): Promise<unknown>;
  close(): void;
  onicecandidate: ((event: { candidate: IceCandidateLike | null }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
}

export type PeerConnectionFactory = (config: RTCConfiguration) => PeerConnectionLike;

export const GAME_CHANNEL_LABEL = 'game';
export const CONTROL_CHANNEL_LABEL = 'control';

/**
 * The two data-channel configurations, exactly as specified.
 *
 * The game channel deliberately has no retransmission: adding reliability would
 * convert packet loss into latency, which rollback cannot hide as well as a dropped
 * input that the peer predicts anyway.
 */
export const GAME_CHANNEL_INIT: RTCDataChannelInit = {
  ordered: false,
  maxRetransmits: 0,
};

export const CONTROL_CHANNEL_INIT: RTCDataChannelInit = {
  ordered: true,
};

/** Default ICE configuration. The TURN entry is filled in by /api/turn-credentials. */
export function defaultRtcConfiguration(iceServers: RTCIceServer[] = []): RTCConfiguration {
  return {
    iceServers,
    bundlePolicy: 'max-bundle',
  };
}

export const STUN_ONLY: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** Coerce whatever the browser hands us into bytes without copying when possible. */
export function toPacket(data: unknown): Packet | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

/** Monotonic clock with a millisecond resolution; injectable for tests. */
export type Now = () => number;

export const defaultNow: Now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();
