import type { AppContext } from '../types';

const STUN = 'stun:stun.cloudflare.com:3478';
// https://developers.cloudflare.com/realtime/turn/generate-credentials/
const TURN_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys/';

export const onRequest = async ({ request, env }: Pick<AppContext, 'request' | 'env'>): Promise<Response> => {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'POST' } });
  }
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return Response.json({ error: 'TURN unavailable' }, { status: 503, headers });
  }
  const configured = Number(env.TURN_TTL_SECONDS);
  const ttl = Number.isFinite(configured) && configured >= 1 ? Math.min(Math.floor(configured), 86400) : 3600;
  let upstream: Response;
  try {
    upstream = await fetch(`${TURN_ENDPOINT}${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
    });
  } catch {
    return Response.json({ error: 'TURN upstream unavailable' }, { status: 504, headers });
  }
  if (!upstream.ok) return Response.json({ error: 'TURN upstream failure' }, { status: 502, headers });
  try {
    const payload = await upstream.json() as { iceServers: { urls: string[]; username?: string; credential?: string }[] };
    // Allowlist response fields and reject malformed results; never forward upstream diagnostics.
    const iceServers = payload.iceServers.map(server => {
      if (!Array.isArray(server.urls) || !server.urls.every(url => typeof url === 'string')) throw new Error('Invalid URLs');
      if ((server.username !== undefined && typeof server.username !== 'string') ||
          (server.credential !== undefined && typeof server.credential !== 'string')) throw new Error('Invalid credentials');
      return { urls: server.urls, username: server.username, credential: server.credential };
    });
    const body = JSON.stringify({ iceServers: [{ urls: [STUN] }, ...iceServers] });
    // Also block accidental secret reflection inside an otherwise valid upstream result.
    if (body.includes(JSON.stringify(env.TURN_KEY_API_TOKEN).slice(1, -1))) throw new Error('Secret reflection');
    return new Response(body, { headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch {
    return Response.json({ error: 'TURN upstream failure' }, { status: 502, headers });
  }
};
