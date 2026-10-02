// Fail closed: token rejection stays generic (403); deployment/JWKS failures return a
// diagnostic 503 and log only a fixed reason, never request data or upstream details.
import type { AppContext, AppEnv } from './types';

type FetchJwks = (url: string) => Promise<Response>;
const SKEW_SECONDS = 30;
type ServiceFailureReason = 'access_configuration_missing' | 'access_jwks_unavailable' | 'access_jwks_invalid';
class AccessServiceError extends Error {
  constructor(readonly reason: ServiceFailureReason) { super(reason); }
}

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
    throw new AccessServiceError('access_configuration_missing');
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
  let response: Response;
  try {
    response = await fetchJwks(`${issuer}/cdn-cgi/access/certs`);
  } catch {
    throw new AccessServiceError('access_jwks_unavailable');
  }
  if (!response.ok) throw new AccessServiceError('access_jwks_unavailable');
  let keys: Record<string, unknown>[];
  try {
    const jwks = object(await response.json());
    if (!Array.isArray(jwks.keys)) throw new Error('Invalid JWKS');
    keys = jwks.keys.map(object);
  } catch {
    throw new AccessServiceError('access_jwks_invalid');
  }
  // Unknown/ambiguous kid remains a generic rejection: it is selected by the request.
  const candidates = keys.filter(key => key.kid === header.kid && key.kty === 'RSA');
  if (candidates.length !== 1) throw new Error('Ambiguous or missing key');
  const key = await crypto.subtle.importKey('jwk', candidates[0] as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`))) throw new Error('Invalid signature');
}

export function createMiddleware(fetchJwks: FetchJwks) {
  return async ({ request, env, next }: AppContext): Promise<Response> => {
    // Missing branch metadata disables bypass; trust configuration failures are diagnosed below.
    // Production branch must remain main in Pages.
    // Access coverage of custom domains/previews and actual bindings require deployment verification.
    if (env.ACCESS_DEV_BYPASS === '1' && env.CF_PAGES_BRANCH && env.CF_PAGES_BRANCH !== 'main') {
      return next();
    }
    try {
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token) throw new Error('Missing JWT');
      await verify(token, env, fetchJwks);
    } catch (error) {
      if (error instanceof AccessServiceError) {
        console.error('Access verification unavailable:', error.reason);
        return Response.json({ error: 'Service Unavailable', reason: error.reason },
          { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      return Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    // Keep application errors outside the authentication catch.
    return next();
  };
}

export const onRequest = createMiddleware(url => fetch(url, { redirect: 'error' }));
