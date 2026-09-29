import { describe, expect, it, vi } from 'vitest';
import { PEER_ID_KEY, selectBackend, selfIdForThisTab, selfIdFromStorage } from '../../src/net/backend.js';
import { supabaseConfigFromEnv } from '../../src/net/supabase-signaling.js';
import { fetchIceServers, wireSignaling } from '../../src/net/lobby-wiring.js';
import { memoryStorage } from '../../src/ui/settings.js';

describe('signalling backend selection', () => {
  it('uses Supabase when it is configured', () => {
    const selection = selectBackend(new URLSearchParams(), true);
    expect(selection.backend).toBe('supabase');
    expect(selection.unavailable).toBeNull();
  });

  it('reports the lobby as unavailable when Supabase is not configured', () => {
    const selection = selectBackend(new URLSearchParams(), false);
    expect(selection.unavailable).toMatch(/not configured/);
  });

  it('honours the explicit broadcast override even without Supabase', () => {
    const selection = selectBackend(new URLSearchParams('signal=broadcast'), false);
    expect(selection.backend).toBe('broadcast');
    expect(selection.unavailable).toBeNull();
  });

  it('ignores an unknown backend name rather than failing', () => {
    expect(selectBackend(new URLSearchParams('signal=carrier-pigeon'), true).backend).toBe('supabase');
  });

  it('reads the Supabase configuration from Vite env vars', () => {
    expect(supabaseConfigFromEnv({})).toBeNull();
    expect(supabaseConfigFromEnv({ VITE_SUPABASE_URL: '  ' })).toBeNull();
    expect(
      supabaseConfigFromEnv({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'k' }),
    ).toEqual({ url: 'https://x.supabase.co', anonKey: 'k' });
  });
});

describe('peer identity', () => {
  it('is stable across calls and stored', () => {
    const storage = memoryStorage();
    const first = selfIdFromStorage(storage);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(selfIdFromStorage(storage)).toBe(first);
  });

  it('is per tab, not per origin, even though the tabs share localStorage', () => {
    // This is the bug the two-tab browser test caught: every tab of an origin shares
    // localStorage, so an id taken from there is the same in both tabs, and
    // BroadcastSignalingChannel ignores messages whose sender is itself. Two tabs then
    // sit in the same room and never negotiate.
    const shared = memoryStorage();
    const tabA = selfIdForThisTab({ localStorage: shared, sessionStorage: memoryStorage() });
    const tabB = selfIdForThisTab({ localStorage: shared, sessionStorage: memoryStorage() });

    expect(tabA).toMatch(/^[0-9a-f]{16}$/);
    expect(tabA).not.toBe(tabB);
    expect(shared.getItem(PEER_ID_KEY)).toBeNull();
  });

  it('survives a reload of the same tab', () => {
    const session = memoryStorage();
    const scope = { localStorage: memoryStorage(), sessionStorage: session };
    const first = selfIdForThisTab(scope);
    expect(selfIdForThisTab(scope)).toBe(first);
    expect(session.getItem(PEER_ID_KEY)).toBe(first);
  });

  it('still produces an identity when storage is unavailable', () => {
    const blocked = {
      get sessionStorage(): null {
        throw new Error('blocked by the browser');
      },
    };
    expect(selfIdForThisTab(blocked)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is what the lobby wiring actually uses', () => {
    const shared = memoryStorage();
    const wire = (): string =>
      wireSignaling(new URLSearchParams('signal=broadcast'), {}, { localStorage: shared, sessionStorage: memoryStorage() }, 'nick')
        .selfId;

    expect(wire()).not.toBe(wire());
    expect(shared.getItem(PEER_ID_KEY)).toBeNull();
  });
});

describe('TURN credentials', () => {
  it('returns the relay configuration from the API', async () => {
    const iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'turn:turn.cloudflare.com:3478' }];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ iceServers }), { status: 200 }));

    const result = await fetchIceServers(fetchImpl as unknown as typeof fetch);
    expect(result.error).toBeNull();
    expect(result.iceServers).toEqual(iceServers);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/turn-credentials',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('falls back to STUN when the endpoint refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }));
    const result = await fetchIceServers(fetchImpl as unknown as typeof fetch);
    expect(result.error).toMatch(/HTTP 403/);
    expect(result.iceServers).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
  });

  it('falls back to STUN when the response is empty', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ iceServers: [] }), { status: 200 }));
    const result = await fetchIceServers(fetchImpl as unknown as typeof fetch);
    expect(result.error).toMatch(/empty/);
  });

  it('falls back to STUN when the network fails, without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const result = await fetchIceServers(fetchImpl as unknown as typeof fetch);
    expect(result.error).toMatch(/failed/);
    expect(result.iceServers.length).toBe(1);
  });

  it('gives up rather than hanging forever', async () => {
    // A TURN request that never settles must not leave the lobby spinning.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const result = await fetchIceServers(fetchImpl as unknown as typeof fetch, 10);
    expect(result.error).toMatch(/timed out/);
  });
});
