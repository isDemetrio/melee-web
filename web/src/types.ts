/**
 * Shared types for the browser shell.
 *
 * Vocabulary used consistently across the codebase:
 *  - peer      : one browser participating in a match
 *  - host      : the peer that creates the room (port 1 in game terms)
 *  - guest     : the peer that joins an existing room (port 2)
 *  - signal    : SDP/ICE exchange messages, carried by a SignalingChannel
 *  - transport : the unreliable data path carrying guest input packets
 */

/** A four-letter room code, uppercase, ambiguity-free alphabet. */
export type RoomCode = string;

/** Stable identifier for one peer inside a room. */
export type PeerId = string;

export type PeerRole = 'host' | 'guest';

export type ScreenName = 'boot' | 'settings' | 'lobby' | 'game';

/** Messages exchanged over the signalling channel. SDP and ICE only. */
export type SignalMessage =
  | { readonly kind: 'hello'; readonly nickname: string }
  | { readonly kind: 'offer'; readonly sdp: string }
  | { readonly kind: 'answer'; readonly sdp: string }
  | { readonly kind: 'candidate'; readonly candidate: string; readonly sdpMid: string | null; readonly sdpMLineIndex: number | null }
  | { readonly kind: 'bye' };

export type TransportState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

/** Byte payload of one Slippi packet, exactly as the netcode produced it. */
export type Packet = Uint8Array;

export interface TransportStats {
  readonly rttMs: number | null;
  readonly packetsSent: number;
  readonly packetsReceived: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

/** How the object holding a file's bytes is encoded, as declared in the manifest. */
export type AssetEncoding = 'gzip' | 'identity';

/** Frozen description of one available game asset, as published in the manifest. */
export interface AssetEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly group: AssetGroup;
  /** Bucket key of the bytes: the SHA-256 of the *uncompressed* file, plus `.bin`. */
  readonly stored: string;
  readonly encoding: AssetEncoding;
}

export type AssetGroup =
  | 'boot'
  | 'menu'
  | `character:${string}`
  | `stage:${string}`
  | 'music'
  | 'movies'
  | 'other';

export interface AssetManifest {
  readonly version: string;
  readonly generatedAt: string;
  readonly baseUrl: string;
  readonly entries: readonly AssetEntry[];
}
