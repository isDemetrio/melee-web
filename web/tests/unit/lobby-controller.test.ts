import { describe, expect, it, vi } from 'vitest';
import { LobbyController } from '../../src/lobby/controller.js';
import { InMemorySignalingHub } from '../../src/net/signaling.js';
import { makeLinkedFactory } from './fakes/fakePeerConnection.js';

function buildLobby(selfId: string) {
  const hub = new InMemorySignalingHub();
  const linked = makeLinkedFactory();
  const controller = new LobbyController({
    selfId,
    nickname: selfId,
    signaling: hub.create({ selfId, nickname: selfId }),
    createPeerConnection: linked.factory,
    peerTimeoutMs: 2000,
  });
  return { hub, linked, controller };
}

describe('lobby controller', () => {
  it('assigns the creator as host and reaches ready after a full handshake', async () => {
    const hub = new InMemorySignalingHub();
    const linked = makeLinkedFactory();
    const host = new LobbyController({
      selfId: 'host',
      nickname: 'Host',
      signaling: hub.create({ selfId: 'host', nickname: 'Host' }),
      createPeerConnection: linked.factory,
      peerTimeoutMs: 2000,
    });
    const guest = new LobbyController({
      selfId: 'guest',
      nickname: 'Guest',
      signaling: hub.create({ selfId: 'guest', nickname: 'Guest' }),
      createPeerConnection: linked.factory,
      peerTimeoutMs: 2000,
    });

    const code = await host.createRoom();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(host.snapshot().role).toBe('host');

    await guest.joinRoom(code);
    expect(guest.snapshot().role).toBe('guest');

    await vi.waitFor(() => expect(linked.pair()[0].channels).toHaveLength(2));
    linked.pair()[0].establish();

    await vi.waitFor(() => expect(host.snapshot().state).toBe('ready'));
    await vi.waitFor(() => expect(guest.snapshot().state).toBe('ready'));
    expect(host.snapshot().transport).not.toBeNull();
    expect(host.snapshot().peers.length).toBe(2);
  });

  it('refuses a malformed room code with an explanation a human can act on', async () => {
    const { controller } = buildLobby('host');
    expect(await controller.joinRoom('AB1')).toBeNull();
    expect(controller.snapshot().error).toMatch(/valid room code/);
    expect(controller.snapshot().state).toBe('error');
  });

  it('accepts a code the way people actually type it', async () => {
    const { controller } = buildLobby('guest');
    expect(await controller.joinRoom(' ab-cd ')).toBe('ABCD');
  });

  it('rejects a third player instead of silently pairing the wrong two', async () => {
    // Slippi's netcode supports 1v1 and 2v2-as-a-mesh; a three-way room is not a thing.
    const hub = new InMemorySignalingHub();
    const linked = makeLinkedFactory();
    const make = (selfId: string) =>
      new LobbyController({
        selfId,
        nickname: selfId,
        signaling: hub.create({ selfId, nickname: selfId }),
        createPeerConnection: linked.factory,
        peerTimeoutMs: 2000,
      });

    const host = make('host');
    const guest = make('guest');
    const third = make('third');

    const code = await host.createRoom();
    await guest.joinRoom(code);
    await third.joinRoom(code);

    expect(third.snapshot().state).toBe('error');
    expect(third.snapshot().error).toMatch(/room is full/);
  });

  it('tears the session down and tells the peer when a player leaves', async () => {
    const hub = new InMemorySignalingHub();
    const linked = makeLinkedFactory();
    const host = new LobbyController({
      selfId: 'host',
      nickname: 'Host',
      signaling: hub.create({ selfId: 'host', nickname: 'Host' }),
      createPeerConnection: linked.factory,
      peerTimeoutMs: 2000,
    });
    const guest = new LobbyController({
      selfId: 'guest',
      nickname: 'Guest',
      signaling: hub.create({ selfId: 'guest', nickname: 'Guest' }),
      createPeerConnection: linked.factory,
      peerTimeoutMs: 2000,
    });

    const code = await host.createRoom();
    await guest.joinRoom(code);
    await vi.waitFor(() => expect(linked.pair()[0].channels).toHaveLength(2));
    linked.pair()[0].establish();
    await vi.waitFor(() => expect(host.snapshot().state).toBe('ready'));

    await guest.leave();

    await vi.waitFor(() => expect(host.snapshot().state).toBe('closed'));
    expect(host.snapshot().transport).not.toBeNull();
  });

  it('notifies subscribers immediately with the current snapshot', () => {
    const { controller } = buildLobby('host');
    const seen: string[] = [];
    controller.onChange((snapshot) => seen.push(snapshot.state));
    expect(seen).toEqual(['idle']);
  });
});
