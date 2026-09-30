import type { SignalingChannel } from './signaling.js';
import { BroadcastSignalingChannel } from './broadcast-signaling.js';
import { SupabaseSignalingChannel, supabaseConfigFromEnv } from './supabase-signaling.js';
import {
  selectBackend,
  selfIdForThisTab,
  type PeerIdScope,
  type SignalingSelection,
} from './backend.js';
import { STUN_ONLY } from './transport.js';

/**
 * Wiring for the lobby: which signalling backend, which identity, and which ICE servers.
 *
 * All three have a working default so that the lobby never fails to start because an
 * optional service is missing. A missing Supabase configuration is reported to the user
 * as "lobby unavailable" rather than crashing the screen.
 */

export interface LobbyWiring {
  readonly selection: SignalingSelection;
  readonly selfId: string;
  readonly signaling: SignalingChannel | null;
}

export function wireSignaling(
  params: URLSearchParams,
  env: Record<string, string | undefined>,
  scope: PeerIdScope,
  nickname: string,
): LobbyWiring {
  const config = supabaseConfigFromEnv(env);
  const selection = selectBackend(params, config !== null);
  // Per-tab identity: see selfIdForThisTab. A shared id makes two tabs invisible to
  // each other, which is the one thing the broadcast backend must not do.
  const selfId = selfIdForThisTab(scope);
  const options = { selfId, nickname };

  if (selection.backend === 'broadcast') {
    return { selection, selfId, signaling: new BroadcastSignalingChannel(options) };
  }
  if (config === null) {
    return { selection, selfId, signaling: null };
  }
  return { selection, selfId, signaling: new SupabaseSignalingChannel(options, config) };
}

/**
 * Fetch short-lived TURN credentials from the Pages Function.
 *
 * Failure is expected and handled: without credentials the connection still works on
 * most home networks via STUN, so the lobby falls back to STUN-only rather than refusing
 * to start. The reason is returned so the UI can say why the relay is unavailable.
 */
export async function fetchIceServers(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<{ iceServers: RTCIceServer[]; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('/api/turn-credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { iceServers: STUN_ONLY, error: `TURN credentials unavailable (HTTP ${response.status})` };
    }
    const body = (await response.json()) as { iceServers?: RTCIceServer[] };
    if (!Array.isArray(body.iceServers) || body.iceServers.length === 0) {
      return { iceServers: STUN_ONLY, error: 'TURN credentials response was empty' };
    }
    return { iceServers: body.iceServers, error: null };
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === 'AbortError' ? 'timed out' : 'failed';
    return { iceServers: STUN_ONLY, error: `TURN credentials request ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}
