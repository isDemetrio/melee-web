import type { PeerId, RoomCode, SignalMessage } from '../types.js';
import { SignalBus, type SignalingChannel, type SignalingOptions } from './signaling.js';

/**
 * Production signalling: Supabase Realtime Broadcast + Presence on a private channel
 * named `room:<CODE>` (docs/SPEC_PIANO.md §3.3).
 *
 * Design notes that matter:
 *  - The Supabase client is imported dynamically. A build with no `VITE_SUPABASE_URL`
 *    configured must still start and show a clear "lobby unavailable" message rather than
 *    crashing the boot screen, and the bundle must not carry a client it cannot use.
 *  - Realtime broadcasts are not ordered and not guaranteed. That is acceptable here:
 *    SDP and ICE are retried by the negotiation, and the game data path is WebRTC.
 *  - Only signalling travels over Supabase. Nothing about the simulation does.
 */

const CHANNEL_PREFIX = 'room:';
const BROADCAST_EVENT = 'signal';

export interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

/** Read the configuration from Vite env vars. Absent means the lobby is unavailable. */
export function supabaseConfigFromEnv(env: Record<string, string | undefined>): SupabaseConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim();
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** The slice of the Supabase Realtime channel API this adapter uses. */
interface RealtimeChannelLike {
  on(type: string, filter: { event: string }, handler: (payload: { payload: unknown }) => void): RealtimeChannelLike;
  subscribe(callback?: (status: string) => void): RealtimeChannelLike;
  send(args: { type: string; event: string; payload: unknown }): Promise<unknown>;
  track(payload: Record<string, unknown>): Promise<unknown>;
  presenceState(): Record<string, Array<{ peerId?: string }>>;
  unsubscribe(): Promise<unknown>;
}

interface SupabaseClientLike {
  channel(name: string, options?: { config?: { broadcast?: { self?: boolean }; presence?: { key?: string } } }): RealtimeChannelLike;
  auth: { signInAnonymously(): Promise<{ error: unknown }> };
}

export type SupabaseClientFactory = (config: SupabaseConfig) => Promise<SupabaseClientLike>;

/** Default factory: loads @supabase/supabase-js only when it is actually needed. */
export const defaultSupabaseClientFactory: SupabaseClientFactory = async (config) => {
  const mod = await import('@supabase/supabase-js');
  return mod.createClient(config.url, config.anonKey) as unknown as SupabaseClientLike;
};

export class SupabaseSignalingChannel implements SignalingChannel {
  private readonly bus = new SignalBus();
  private readonly peersById = new Set<PeerId>();
  private channel: RealtimeChannelLike | null = null;

  constructor(
    private readonly options: SignalingOptions,
    private readonly config: SupabaseConfig,
    private readonly createClient: SupabaseClientFactory = defaultSupabaseClientFactory,
  ) {}

  async join(code: RoomCode): Promise<void> {
    const client = await this.createClient(this.config);

    // Anonymous sign-in: the site itself is already gated by Cloudflare Access
    // (docs/SPEC_PIANO.md §3.3), so the Supabase identity only needs to be stable.
    const auth = await client.auth.signInAnonymously();
    if (auth.error) throw new Error('lobby: anonymous sign-in failed');

    const channel = client.channel(CHANNEL_PREFIX + code, {
      config: {
        broadcast: { self: false },
        presence: { key: this.options.selfId },
      },
    });

    channel.on('broadcast', { event: BROADCAST_EVENT }, (payload) => {
      const body = payload.payload as { from?: unknown; to?: unknown; message?: unknown } | null;
      if (!body || typeof body.from !== 'string') return;
      if (typeof body.to === 'string' && body.to !== this.options.selfId) return;
      this.bus.emitMessage(body.from, body.message as SignalMessage);
    });

    channel.on('presence', { event: 'sync' }, () => {
      this.refreshPresence();
    });

    this.channel = channel;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lobby: subscribe timed out')), 10_000);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          reject(new Error(`lobby: subscribe failed (${status})`));
        }
      });
    });

    await channel.track({ peerId: this.options.selfId, nickname: this.options.nickname });
    this.peersById.add(this.options.selfId);
    this.refreshPresence();
  }

  peers(): readonly PeerId[] {
    return [...this.peersById];
  }

  send(to: PeerId, message: SignalMessage): void {
    void this.channel?.send({
      type: 'broadcast',
      event: BROADCAST_EVENT,
      payload: { from: this.options.selfId, to, message },
    });
  }

  broadcast(message: SignalMessage): void {
    void this.channel?.send({
      type: 'broadcast',
      event: BROADCAST_EVENT,
      payload: { from: this.options.selfId, message },
    });
  }

  onMessage(handler: (from: PeerId, message: SignalMessage) => void): () => void {
    return this.bus.onMessage(handler);
  }

  onPresence(handler: (peers: readonly PeerId[]) => void): () => void {
    return this.bus.onPresence(handler);
  }

  async leave(): Promise<void> {
    await this.channel?.unsubscribe();
    this.channel = null;
    this.peersById.clear();
    this.bus.clear();
  }

  private refreshPresence(): void {
    const state = this.channel?.presenceState() ?? {};
    const ids = new Set<PeerId>();
    for (const metas of Object.values(state)) {
      for (const meta of metas) {
        if (typeof meta.peerId === 'string') ids.add(meta.peerId);
      }
    }
    if (ids.size === 0) ids.add(this.options.selfId);
    this.peersById.clear();
    for (const id of ids) this.peersById.add(id);
    this.bus.emitPresence([...this.peersById]);
  }
}
