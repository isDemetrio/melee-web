import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMiddleware, onRequest } from '../../functions/_middleware';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const env = { ACCESS_AUD: 'application', ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', CF_PAGES_BRANCH: 'main' };
const now = 1_800_000_000;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const input = `${encode({ alg: 'RS256', kid: 'test-key', ...header })}.${encode({
    aud: ['application'], iss: 'https://test.cloudflareaccess.com', exp: now + 300, nbf: now - 60, ...claims,
  })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
function context(jwt?: string, overrides = {}) {
  return {
    request: new Request('https://game.test/api/health', { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} }),
    env: { ...env, ...overrides }, next: vi.fn(async () => new Response('next handler')),
  };
}
// Constructed Responses have no URL; model the final URL supplied by the fetch runtime.
function withUrl(response: Response, url = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`): Response {
  return Object.defineProperty(response, 'url', { value: url });
}
const fetchJwks = vi.fn(async (_url: string) => withUrl(Response.json({ keys: [jwk] })));
const middleware = createMiddleware(fetchJwks);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  fetchJwks.mockReset().mockImplementation(async () => withUrl(Response.json({ keys: [jwk] })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function denied(jwt?: string, overrides = {}) {
  const ctx = context(jwt, overrides);
  const response = await middleware(ctx);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Forbidden' });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(ctx.next).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
}

async function unavailable(reason: string, overrides = {}) {
  const ctx = context(token(), overrides);
  const response = await middleware(ctx);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Service Unavailable', reason });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(ctx.next).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledWith('Access verification unavailable:', reason);
}

describe('Access JWT', () => {
  it.each([
    {}, { aud: 'application' }, { nbf: undefined }, { exp: now - 29 }, { nbf: now + 30 },
  ])('passes a signed token with permitted claims %j', async claims => {
    const ctx = context(token(claims));
    const response = await middleware(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('next handler');
    expect(ctx.next).toHaveBeenCalledOnce();
    expect(fetchJwks).toHaveBeenCalledWith('https://test.cloudflareaccess.com/cdn-cgi/access/certs');
  });
  it.each([
    { aud: 'wrong' }, { aud: undefined }, { aud: [] }, { iss: 'https://evil.test' },
    { exp: now - 31 }, { exp: now - 30 }, { exp: undefined }, { exp: 'tomorrow' }, { exp: null },
    { nbf: now + 31 }, { nbf: 'later' }, { nbf: null },
  ])('rejects invalid claims %j', async claims => { await denied(token(claims)); });
  it('rejects missing header', async () => {
    await denied();
    expect(fetchJwks).not.toHaveBeenCalled();
  });
  it('keeps missing tokens generic even without trust configuration', async () => {
    await denied(undefined, { ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined });
    expect(fetchJwks).not.toHaveBeenCalled();
  });
  it('does not fetch JWKS for malformed tokens during an outage', async () => {
    fetchJwks.mockRejectedValue(new Error('private network detail'));
    await denied('invalid');
    expect(fetchJwks).not.toHaveBeenCalled();
  });
  it('rejects a tampered signature', async () => {
    const parts = token().split('.');
    const signature = Buffer.from(parts[2], 'base64url');
    signature[0] ^= 1;
    await denied(`${parts[0]}.${parts[1]}.${signature.toString('base64url')}`);
  });
  it.each([
    { alg: 'HS256' }, { kid: undefined }, { kid: 123 }, { kid: 'unknown' }, { crit: ['unknown'] },
  ])('rejects unsupported headers %j', async header => { await denied(token({}, header)); });
  it.each(['invalid', 'a.b.c.d', '*.e30.AA', 'e30.!.AA', 'bnVsbA.e30.AA', 'W10.e30.AA', 'MQ.e30.AA', 'e30.bnVsbA.AA'])('rejects malformed JWT %s', async jwt => {
    await denied(jwt);
  });
  it.each([
    { ACCESS_AUD: undefined }, { ACCESS_AUD: '' }, { ACCESS_TEAM_DOMAIN: undefined }, { ACCESS_TEAM_DOMAIN: 'evil.test' },
    { ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com' },
  ])('rejects invalid configuration %j', async overrides => {
    await unavailable('access_configuration_missing', overrides);
    expect(fetchJwks).not.toHaveBeenCalled();
  });
  it.each([
    { keys: [] }, { keys: [jwk, jwk] },
    { keys: [{ ...jwk, kty: 'EC' }] }, { keys: [{ ...jwk, n: 'invalid' }] },
  ])('rejects unusable JWKS %j', async body => {
    fetchJwks.mockResolvedValue(withUrl(Response.json(body)));
    await denied(token());
  });
  it.each([{}, null, [], { keys: 'wrong' }, { keys: [null] }].map(body => ({ body })))('diagnoses malformed JWKS %j', async ({ body }) => {
    fetchJwks.mockResolvedValue(withUrl(Response.json(body)));
    await unavailable('access_jwks_invalid');
  });
  it('accepts a final URL at another path on the team host', async () => {
    fetchJwks.mockResolvedValue(withUrl(Response.json({ keys: [jwk] }), `https://${env.ACCESS_TEAM_DOMAIN}/rotated-certs`));
    const ctx = context(token());
    expect((await middleware(ctx)).status).toBe(200);
    expect(ctx.next).toHaveBeenCalledOnce();
  });
  it.each([
    'https://other.cloudflareaccess.com/cdn-cgi/access/certs',
    `https://${env.ACCESS_TEAM_DOMAIN}.evil.test/certs`,
    `https://${env.ACCESS_TEAM_DOMAIN}:8443/certs`,
    '', 'not a URL',
  ])('fails closed on an untrusted or invalid final JWKS URL %j', async url => {
    fetchJwks.mockResolvedValue(withUrl(Response.json({ keys: [jwk] }), url));
    await unavailable('access_jwks_unavailable');
  });
  it('fails closed when the runtime provides no final URL', async () => {
    const response = Response.json({ keys: [jwk] });
    fetchJwks.mockResolvedValue(Object.defineProperty(response, 'url', { value: undefined }));
    await unavailable('access_jwks_unavailable');
  });
  it.each([404, 500])('fails closed on JWKS HTTP error %s', async status => {
    fetchJwks.mockResolvedValue(withUrl(new Response('private upstream error', { status })));
    await unavailable('access_jwks_unavailable');
  });
  it('fails closed on JWKS network errors', async () => {
    fetchJwks.mockRejectedValue(new Error('private network detail'));
    await unavailable('access_jwks_unreachable');
  });
  it('fails closed on malformed JWKS JSON', async () => {
    fetchJwks.mockResolvedValue(withUrl(new Response('{')));
    await unavailable('access_jwks_invalid');
  });
  it('uses global fetch in the Pages entry point', async () => {
    const fetch = vi.fn().mockResolvedValue(withUrl(Response.json({ keys: [jwk] })));
    vi.stubGlobal('fetch', fetch);
    expect((await onRequest(context(token()))).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith('https://test.cloudflareaccess.com/cdn-cgi/access/certs');
  });
  it('does not turn downstream application errors into authentication errors', async () => {
    const ctx = context(token());
    ctx.next.mockRejectedValue(new Error('application failure'));
    await expect(middleware(ctx)).rejects.toThrow('application failure');
  });
});

describe('development bypass', () => {
  it.each(['main', '', undefined])('refuses bypass on branch %s', async branch => {
    await denied(undefined, { ACCESS_DEV_BYPASS: '1', CF_PAGES_BRANCH: branch });
  });
  it.each(['0', 'true', undefined])('requires exact opt-in %s', async bypass => {
    await denied(undefined, { ACCESS_DEV_BYPASS: bypass, CF_PAGES_BRANCH: 'preview' });
  });
  it('allows explicit non-production development bypass without JWKS', async () => {
    const ctx = context(undefined, { ACCESS_DEV_BYPASS: '1', CF_PAGES_BRANCH: 'preview' });
    expect((await middleware(ctx)).status).toBe(200);
    expect(ctx.next).toHaveBeenCalledOnce();
    expect(fetchJwks).not.toHaveBeenCalled();
  });
  it('still verifies valid production requests when bypass is set', async () => {
    expect((await middleware(context(token(), { ACCESS_DEV_BYPASS: '1' }))).status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledOnce();
  });
});
