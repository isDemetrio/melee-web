import { describe, expect, it, vi } from 'vitest';
import { MatchSession } from '../../src/net/session.js';
import { InMemorySignalingHub } from '../../src/net/signaling.js';
import { makeLinkedFactory } from './fakes/fakePeerConnection.js';

/**
 * These tests run the real negotiation code — MatchSession and WebRtcTransport — against
 * a fake RTCPeerConnection. What they prove: role handling, SDP/ICE ordering, the
 * ICE-before-SDP race, readiness gating on the game channel, and teardown.
 * What they cannot prove: that Chromium and Safari agree on SDP. That is the Playwright
 * test's job (tests/e2e/rtc.spec.ts).
 */
function buildRoom(peerTimeoutMs = 2000) {
  const hub = new InMemorySignalingHub();
  const linked = makeLinkedFactory();
  const hostSignaling = hub.create({ selfId: 'host', nickname: 'Host' });
  const guestSignaling = hub.create({ selfId: 'guest', nickname: 'Guest' });

  const host = new MatchSession({
    role: 'host',
    selfId: 'host',
    nickname: 'Host',
    code: 'ABCD',
    signaling: hostSignaling,
    createPeerConnection: linked.factory,
    peerTimeoutMs,
  });
  const guest = new MatchSession({
    role: 'guest',
    selfId: 'guest',
    nickname: 'Guest',
    code: 'ABCD',
    signaling: guestSignaling,
    createPeerConnection: linked.factory,
    peerTimeoutMs,
  });

  return { hub, linked, host, guest };
}

describe('match session negotiation', () => {
  it('takes host and guest from lobby to a ready transport', async () => {
    const { host, guest, linked } = buildRoom();

    await host.start();
    await guest.start();
    expect(host.state).toBe('waiting-for-peer');

    await vi.waitFor(() => expect(linked.pair()[0].channels).toHaveLength(2));

    const hostReady = host.whenReady();
    const guestReady = guest.whenReady();
    const [hostPc, guestPc] = linked.pair();

    expect(hostPc.localDescription?.type).toBe('offer');
    expect(guestPc.localDescription?.type).toBe('answer');

    hostPc.establish();

    const hostTransport = await hostReady;
    const guestTransport = await guestReady;

    expect(host.state).toBe('ready');
    expect(guest.state).toBe('ready');
    expect(hostTransport.state).toBe('connected');
    expect(guestTransport.state).toBe('connected');
  });

  it('carries packets both ways over the unreliable channel', async () => {
    const { host, guest, linked } = buildRoom();
    await host.start();
    await guest.start();
    await vi.waitFor(() => expect(linked.pair()[0].channels).toHaveLength(2));
    const [hostPc] = linked.pair();

    const hostReady = host.whenReady();
    const guestReady = guest.whenReady();
    hostPc.establish();
    const hostTransport = await hostReady;
    const guestTransport = await guestReady;

    const atGuest: Uint8Array[] = [];
    const atHost: Uint8Array[] = [];
    guestTransport.onPacket((packet) => atGuest.push(packet));
    hostTransport.onPacket((packet) => atHost.push(packet));

    hostTransport.send(new Uint8Array([1, 2, 3]));
    guestTransport.send(new Uint8Array([4, 5, 6]));
    guestTransport.sendReliable(new Uint8Array([7]));

    expect([...atGuest[0]!]).toEqual([1, 2, 3]);
    expect([...atHost[0]!]).toEqual([4, 5, 6]);
    expect([...atHost[1]!]).toEqual([7]);
    expect(hostTransport.stats().packetsSent).toBe(1);
    expect(guestTransport.stats().packetsReceived).toBe(1);
  });

  it('queues ICE candidates that arrive before the offer instead of dropping them', async () => {
    // The host gathers a candidate as soon as it sets its local description, and the
    // signalling service can deliver that candidate before the offer. Dropping it is the
    // classic "works on Wi-Fi, fails on 4G" bug, so it is pinned here.
    const { host, guest, linked } = buildRoom();
    await host.start();
    await guest.start();
    await vi.waitFor(() => expect(linked.pair()[0].channels).toHaveLength(2));
    const [, guestPc] = linked.pair();

    expect(guestPc.remoteDescription?.type).toBe('offer');
    expect(guestPc.addedCandidates).toHaveLength(1);
    expect(guestPc.addedCandidates[0]?.candidate).toBe('candidate-host');
  });

  it('fails with a clear error when nobody joins the room in time', async () => {
    const hub = new InMemorySignalingHub();
    const linked = makeLinkedFactory();
    const host = new MatchSession({
      role: 'host',
      selfId: 'host',
      nickname: 'Host',
      code: 'ZZZZ',
      signaling: hub.create({ selfId: 'host', nickname: 'Host' }),
      createPeerConnection: linked.factory,
      peerTimeoutMs: 30,
    });

    await host.start();
    const ready = host.whenReady();
    await expect(ready).rejects.toThrow(/no peer joined room ZZZZ/);
    expect(host.state).toBe('failed');
  });

  it('never starts a match before the game channel is open', async () => {
    // The control channel opens first on some stacks. Readiness must key on the game
    // channel, otherwise the first input packet is lost and the match desyncs on frame 1.
    const { host, guest, linked } = buildRoom();
    await host.start();
    await guest.start();
    await vi.waitFor(() => expect(linked.pair()[0].channels).toHaveLength(2));
    const [hostPc] = linked.pair();

    const ready = host.whenReady();
    const [gameChannel, controlChannel] = hostPc.channels;
    controlChannel!.open();
    expect(host.state).not.toBe('ready');

    gameChannel!.open();
    await expect(ready).resolves.toBeDefined();
  });

  it('tells the other player when one side leaves', async () => {
    const { host, guest, linked } = buildRoom();
    await host.start();
    await guest.start();
    await vi.waitFor(() => expect(linked.pair()[0].channels).toHaveLength(2));

    host.close();
    expect(host.state).toBe('closed');
    expect(guest.state).toBe('closed');
  });
});
