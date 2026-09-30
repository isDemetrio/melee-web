import type {
  DataChannelLike,
  IceCandidateLike,
  PeerConnectionFactory,
  PeerConnectionLike,
  SessionDescriptionLike,
} from '../../../src/net/transport.js';

/**
 * A fake RTCPeerConnection, faithful enough to run a complete host/guest handshake in
 * Node with no browser: it routes SDP and ICE between two fakes, and opening a data
 * channel on one side opens the mirrored channel on the other.
 *
 * What it deliberately does NOT model: actual SDP parsing, ICE candidate gathering
 * over a network, and packet loss. Those are covered by the Playwright test, which uses
 * a real Chromium RTCPeerConnection.
 */
export class FakeDataChannel implements DataChannelLike {
  binaryType = 'arraybuffer';
  readyState = 'connecting';
  readonly bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    readonly label: string,
    private readonly peer: FakePeerConnection | null = null,
  ) {}

  send(data: ArrayBufferView | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error(`fake channel ${this.label} is not open`);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(bytes);
    this.peer?.mirrorSend(this, bytes);
  }

  /** Move to open and notify both the local and the mirrored side. */
  open(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this.onopen?.({});
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.({});
  }

  /** Deliver an inbound payload as if it arrived over the network. */
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
}

export class FakePeerConnection implements PeerConnectionLike {
  connectionState = 'new';
  onicecandidate: ((event: { candidate: IceCandidateLike | null }) => void) | null = null;
  onconnectionstatechange: ((event: unknown) => void) | null = null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null = null;

  /** Unique per instance so candidate strings are deterministic within a test run. */
  private static sequence = 0;
  readonly id = `pc${(FakePeerConnection.sequence += 1)}`;

  readonly channels: FakeDataChannel[] = [];
  readonly remoteCandidates: IceCandidateLike[] = [];
  readonly addedCandidates: IceCandidateLike[] = [];
  remoteDescription: SessionDescriptionLike | null = null;
  localDescription: SessionDescriptionLike | null = null;
  closed = false;

  private other: FakePeerConnection | null = null;
  private readonly mirrored = new Map<string, FakeDataChannel>();

  createDataChannel(label: string): DataChannelLike {
    const channel = new FakeDataChannel(label, this);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<SessionDescriptionLike> {
    return { type: 'offer', sdp: `fake-offer-from-${this.id}` };
  }

  async createAnswer(): Promise<SessionDescriptionLike> {
    return { type: 'answer', sdp: `fake-answer-from-${this.id}` };
  }

  async setLocalDescription(description: SessionDescriptionLike): Promise<void> {
    this.localDescription = description;
    // Gather one candidate immediately so the ICE-before-SDP ordering is exercised.
    this.onicecandidate?.({ candidate: { candidate: `candidate-${this.id}`, sdpMid: '0', sdpMLineIndex: 0 } });
  }

  async setRemoteDescription(description: SessionDescriptionLike): Promise<void> {
    this.remoteDescription = description;
    this.remoteCandidates.length = 0;
    for (const candidate of this.addedCandidates) this.remoteCandidates.push(candidate);
  }

  async addIceCandidate(candidate: IceCandidateLike): Promise<void> {
    if (!this.remoteDescription) throw new Error('addIceCandidate before setRemoteDescription');
    this.addedCandidates.push(candidate);
  }

  async getStats(): Promise<unknown> {
    return {};
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
    this.onconnectionstatechange?.({});
    for (const channel of this.channels) channel.close();
  }

  /** Link two fakes so they behave as the two ends of one connection. */
  static link(a: FakePeerConnection, b: FakePeerConnection): void {
    a.other = b;
    b.other = a;
  }

  /** Open every channel created by the host, on both ends. */
  establish(): void {
    for (const channel of this.channels) {
      const mirror = new FakeDataChannel(channel.label, this.other);
      // Both ends must be able to find their counterpart: the host maps a label to the
      // mirror it just created, the guest maps the same label back to the original.
      // Registering only one direction silently swallows every packet sent by the other.
      this.mirrored.set(channel.label, mirror);
      this.other?.receiveChannel(mirror, channel);
      channel.open();
      mirror.open();
    }
    this.connectionState = 'connected';
    this.other!.connectionState = 'connected';
    this.onconnectionstatechange?.({});
    this.other!.onconnectionstatechange?.({});
  }

  private receiveChannel(channel: FakeDataChannel, counterpart: FakeDataChannel): void {
    this.channels.push(channel);
    this.mirrored.set(channel.label, counterpart);
    this.ondatachannel?.({ channel });
  }

  /** Called by a local channel when it sends: deliver to the mirrored channel. */
  mirrorSend(local: FakeDataChannel, bytes: Uint8Array): void {
    const mirror = this.mirrored.get(local.label);
    mirror?.deliver(bytes);
  }
}

/**
 * A factory that hands out linked pairs. Each call to `next()` returns the other end,
 * so a test can build a host and a guest that are already wired to each other.
 */
export function makeLinkedFactory(): {
  factory: PeerConnectionFactory;
  pair(): [FakePeerConnection, FakePeerConnection];
} {
  const created: FakePeerConnection[] = [];
  const factory: PeerConnectionFactory = () => {
    const connection = new FakePeerConnection();
    created.push(connection);
    if (created.length % 2 === 0) {
      const previous = created[created.length - 2]!;
      FakePeerConnection.link(previous, connection);
    }
    return connection;
  };
  return {
    factory,
    pair: () => {
      const a = created[created.length - 2];
      const b = created[created.length - 1];
      if (!a || !b) throw new Error('no pair created yet');
      return [a, b];
    },
  };
}
