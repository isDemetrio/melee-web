import { describe, expect, it } from 'vitest';
import { InMemorySignalingHub } from '../../src/net/signaling.js';
import type { SignalMessage } from '../../src/types.js';

describe('signalling channel contract', () => {
  it('reports presence including self, then both peers after a join', async () => {
    const hub = new InMemorySignalingHub();
    const host = hub.create({ selfId: 'host', nickname: 'Host' });
    const guest = hub.create({ selfId: 'guest', nickname: 'Guest' });

    const seen: string[][] = [];
    host.onPresence((peers) => seen.push([...peers]));

    await host.join('ABCD');
    expect(host.peers()).toEqual(['host']);

    await guest.join('ABCD');
    expect([...host.peers()].sort()).toEqual(['guest', 'host']);
    expect([...guest.peers()].sort()).toEqual(['guest', 'host']);
    expect(seen.at(-1)?.slice().sort()).toEqual(['guest', 'host']);
  });

  it('delivers a message only to the addressed peer', async () => {
    const hub = new InMemorySignalingHub();
    const host = hub.create({ selfId: 'host', nickname: 'Host' });
    const guest = hub.create({ selfId: 'guest', nickname: 'Guest' });
    const stranger = hub.create({ selfId: 'stranger', nickname: 'Third' });

    await host.join('ABCD');
    await guest.join('ABCD');
    await stranger.join('ABCD');

    const received: Array<[string, SignalMessage]> = [];
    guest.onMessage((from, message) => received.push([from, message]));
    stranger.onMessage((from, message) => received.push([`stranger:${from}`, message]));

    host.send('guest', { kind: 'offer', sdp: 'sdp' });

    expect(received).toEqual([['host', { kind: 'offer', sdp: 'sdp' }]]);
  });

  it('broadcasts to every other member and never to self', async () => {
    const hub = new InMemorySignalingHub();
    const host = hub.create({ selfId: 'host', nickname: 'Host' });
    const guest = hub.create({ selfId: 'guest', nickname: 'Guest' });
    await host.join('ABCD');
    await guest.join('ABCD');

    const toGuest: SignalMessage[] = [];
    const toHost: SignalMessage[] = [];
    host.onMessage((_from, message) => toHost.push(message));
    guest.onMessage((_from, message) => toGuest.push(message));

    host.broadcast({ kind: 'hello', nickname: 'Host' });

    expect(toGuest).toEqual([{ kind: 'hello', nickname: 'Host' }]);
    expect(toHost).toEqual([]);
  });

  it('stops delivering after leave', async () => {
    const hub = new InMemorySignalingHub();
    const host = hub.create({ selfId: 'host', nickname: 'Host' });
    const guest = hub.create({ selfId: 'guest', nickname: 'Guest' });
    await host.join('ABCD');
    await guest.join('ABCD');

    const received: SignalMessage[] = [];
    guest.onMessage((_from, message) => received.push(message));
    await guest.leave();

    host.send('guest', { kind: 'offer', sdp: 'ignored' });
    expect(received).toEqual([]);
    expect(hub.peers('ABCD')).toEqual(['host']);
  });

  it('refuses to send before joining, rather than silently dropping', async () => {
    const hub = new InMemorySignalingHub();
    const channel = hub.create({ selfId: 'host', nickname: 'Host' });
    expect(() => channel.broadcast({ kind: 'bye' })).toThrow(/before join/);
  });
});
