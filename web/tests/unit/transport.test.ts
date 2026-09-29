import { describe, expect, it } from 'vitest';
import { WebRtcTransport } from '../../src/net/webrtc.js';
import { GAME_CHANNEL_INIT, CONTROL_CHANNEL_INIT } from '../../src/net/transport.js';
import { FakePeerConnection, makeLinkedFactory } from './fakes/fakePeerConnection.js';

describe('transport channel configuration', () => {
  it('uses UDP semantics on the game channel and reliability on the control channel', () => {
    expect(GAME_CHANNEL_INIT).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(CONTROL_CHANNEL_INIT).toEqual({ ordered: true });
  });
});

describe('WebRtcTransport', () => {
  function build(): { host: WebRtcTransport; guest: WebRtcTransport; pc: FakePeerConnection } {
    const linked = makeLinkedFactory();
    const hostPc = linked.factory({}) as FakePeerConnection;
    const guestPc = linked.factory({}) as FakePeerConnection;
    const host = new WebRtcTransport(hostPc);
    const guest = new WebRtcTransport(guestPc);
    host.open();
    hostPc.establish();
    return { host, guest, pc: hostPc };
  }

  it('reports connected only once the game channel is open', () => {
    const linked = makeLinkedFactory();
    const hostPc = linked.factory({}) as FakePeerConnection;
    linked.factory({});
    const host = new WebRtcTransport(hostPc);
    host.open();
    expect(host.state).toBe('idle');

    hostPc.channels[1]!.open(); // control only
    expect(host.state).toBe('connecting');

    hostPc.channels[0]!.open(); // game
    expect(host.state).toBe('connected');
  });

  it('drops sends on a channel that is not open instead of queueing them', () => {
    const linked = makeLinkedFactory();
    const hostPc = linked.factory({}) as FakePeerConnection;
    const transport = new WebRtcTransport(hostPc);
    transport.open();

    transport.send(new Uint8Array([1]));
    expect(transport.stats().packetsSent).toBe(0);
    expect(hostPc.channels[0]!.sent).toHaveLength(0);
  });

  it('reports failures and closes without throwing', () => {
    const linked = makeLinkedFactory();
    const hostPc = linked.factory({}) as FakePeerConnection;
    const transport = new WebRtcTransport(hostPc);
    transport.open();

    const states: string[] = [];
    transport.onStateChange((state) => states.push(state));

    hostPc.connectionState = 'failed';
    hostPc.onconnectionstatechange?.({});
    expect(transport.state).toBe('failed');

    transport.close();
    expect(states).toContain('failed');
    expect(states).toContain('closed');
  });

  it('counts bytes in both directions and exposes an injected RTT', () => {
    const { host, guest } = build();
    host.send(new Uint8Array(10));
    guest.sendReliable(new Uint8Array(4));

    expect(host.stats().bytesSent).toBe(10);
    expect(guest.stats().bytesReceived).toBe(10);
    expect(guest.stats().bytesSent).toBe(4);
    expect(host.stats().bytesReceived).toBe(4);

    host.recordRtt(42);
    expect(host.stats().rttMs).toBe(42);
    expect(guest.stats().rttMs).toBeNull();
  });

  it('unsubscribes packet handlers cleanly', () => {
    const { host, guest } = build();
    const seen: number[] = [];
    const unsubscribe = guest.onPacket(() => seen.push(1));
    host.send(new Uint8Array([1]));
    unsubscribe();
    host.send(new Uint8Array([2]));
    expect(seen).toHaveLength(1);
  });
});
