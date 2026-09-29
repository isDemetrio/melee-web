import type { AppContext, AppEnv } from './types';

type FetchJwks = (url: string) => Promise<Response>;
const SKEW_SECONDS = 30;

function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected object');
  }
  return value as Record<string, unknown>;
}

async function verify(token: string, env: AppEnv, fetchJwks: FetchJwks): Promise<void> {
  // Restrict the trust anchor to a configured Access team, never a URL supplied by the JWT.
  if (!env.ACCESS_AUD || !/^([a-z0-9-]+)\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN ?? '')) {
    throw new Error('Missing trust configuration');
  }
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Invalid JWT');
  const [headerPart, payloadPart, signaturePart] = segments as [string, string, string];
  const header = object(JSON.parse(new TextDecoder().decode(decode(headerPart))));
  const claims = object(JSON.parse(new TextDecoder().decode(decode(payloadPart))));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) {
    throw new Error('Unsupported JWT');
  }
  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(env.ACCESS_AUD) || claims.iss !== issuer ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || now >= claims.exp + SKEW_SECONDS ||
      (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || now + SKEW_SECONDS < claims.nbf))) {
    throw new Error('Invalid claims');
  }
  // Access publishes rotating RSA keys here; fetch afresh to avoid a stale-key rejection.
  // https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
  const response = await fetchJwks(`${issuer}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error('JWKS unavailable');
  const jwks = object(await response.json());
  if (!Array.isArray(jwks.keys)) throw new Error('Invalid JWKS');
  const candidates = jwks.keys.map(object).filter(key => key.kid === header.kid && key.kty === 'RSA');
  if (candidates.length !== 1) throw new Error('Ambiguous or missing key');
  const key = await crypto.subtle.importKey('jwk', candidates[0] as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`))) throw new Error('Invalid signature');
}

export function createMiddleware(fetchJwks: FetchJwks) {
  return async ({ request, env, next }: AppContext): Promise<Response> => {
    // Missing deployment metadata fails closed. Production branch must remain main in Pages.
    // Access coverage of custom domains/previews and actual bindings require deployment verification.
    if (env.ACCESS_DEV_BYPASS === '1' && env.CF_PAGES_BRANCH && env.CF_PAGES_BRANCH !== 'main') {
      return next();
    }
    try {
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token) throw new Error('Missing JWT');
      await verify(token, env, fetchJwks);
    } catch {
      return Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    // Keep application errors outside the authentication catch.
    return next();
  };
}

export const onRequest = createMiddleware(url => fetch(url, { redirect: 'error' }));
