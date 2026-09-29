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

export function selfIdFromStorage(storage: StorageLike): PeerId {
  const key = 'melee-web.peerId';
  const existing = storage.getItem(key);
  if (existing) return existing;
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const id = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  storage.setItem(key, id);
  return id;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type { SignalingChannel };
