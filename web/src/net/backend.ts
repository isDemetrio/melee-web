import type { PeerId } from '../types.js';
import type { SignalingChannel } from './signaling.js';

/**
 * Which signalling backend to use.
 *
 *  - `supabase`  production: Realtime Broadcast + Presence, two different networks.
 *  - `broadcast` two tabs on the same machine: no server, no credentials. Used by the
 *                Playwright tests and for local debugging.
 *
 * The choice is a URL parameter and is not a security decision: `broadcast` cannot reach
 * another machine, because BroadcastChannel is same-origin.
 */
export type SignalingBackend = 'supabase' | 'broadcast';

export interface SignalingSelection {
  readonly backend: SignalingBackend;
  /** Reason the lobby is unusable, when it is. */
  readonly unavailable: string | null;
}

export function selectBackend(params: URLSearchParams, hasSupabaseConfig: boolean): SignalingSelection {
  const requested = params.get('signal');
  if (requested === 'broadcast') return { backend: 'broadcast', unavailable: null };
  if (!hasSupabaseConfig) {
    return {
      backend: 'supabase',
      unavailable: 'The lobby is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing).',
    };
  }
  return { backend: 'supabase', unavailable: null };
}

export const PEER_ID_KEY = 'melee-web.peerId';

/** The storage a peer id is allowed to come from: per-tab storage, and nothing else. */
export interface PeerIdScope {
  /** Per-tab storage, scoped to one browsing context. The only source of the id. */
  readonly sessionStorage?: StorageLike | null;
  /**
   * Shared, origin-wide storage. Accepted so callers can pass `globalThis` and so tests
   * can assert that the identity does *not* come from here; never read by this module.
   */
  readonly localStorage?: StorageLike | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function randomPeerId(): PeerId {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function selfIdFromStorage(storage: StorageLike): PeerId {
  const existing = storage.getItem(PEER_ID_KEY);
  if (existing) return existing;
  const id = randomPeerId();
  storage.setItem(PEER_ID_KEY, id);
  return id;
}

/**
 * Identity of this tab, stable for as long as the tab lives.
 *
 * It must come from `sessionStorage` and never from `localStorage`, and that is not a
 * detail. Two tabs of the same origin share `localStorage`, so both would present the
 * same peer id; `BroadcastSignalingChannel` ignores any message whose sender is itself
 * (it cannot tell an echo from a stranger carrying the same name), so the two tabs would
 * sit in the same room, ignore each other, and never negotiate — which is precisely the
 * case the broadcast backend exists for. `sessionStorage` is scoped to one browsing
 * context, which is the lifetime the id needs.
 *
 * A per-load identity is worse than a stable one, but far better than a room nobody can
 * join, so storage failures fall back to a random id rather than throwing.
 */
export function selfIdForThisTab(scope: PeerIdScope): PeerId {
  let storage: StorageLike | null = null;
  try {
    storage = scope.sessionStorage ?? null;
  } catch {
    // Reading the property itself can throw when cookies are blocked.
    storage = null;
  }
  if (storage === null) return randomPeerId();
  try {
    return selfIdFromStorage(storage);
  } catch {
    return randomPeerId();
  }
}

export type { SignalingChannel };
