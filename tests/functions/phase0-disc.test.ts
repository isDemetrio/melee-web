import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/phase0/[[path]]';
import { createMiddleware } from '../../functions/_middleware';

// A ten-byte stand-in for the disc. The real object is 1,459,978,240 bytes and is never in the
// repository; every assertion below is about offsets, sizes and headers, not about content.
const DATA = 'abcdefghij';

// Range header, expected status, expected Content-Range, expected body, expected R2 read.
const RANGED_CASES = [
  ['bytes=2-5', 206, 'bytes 2-5/10', 'cdef', { offset: 2, length: 4 }],
  ['bytes=7-', 206, 'bytes 7-9/10', 'hij', { offset: 7, length: 3 }],
  ['bytes=-3', 206, 'bytes 7-9/10', 'hij', { offset: 7, length: 3 }],
  ['bytes=0-99', 206, 'bytes 0-9/10', DATA, { offset: 0, length: 10 }],
  ['bytes=0-0', 206, 'bytes 0-0/10', 'a', { offset: 0, length: 1 }],
] as const;

function bucket(overrides: { size?: number; absent?: boolean } = {}) {
  const size = overrides.size ?? DATA.length;
  const head = vi.fn(async (): Promise<{ size: number } | null> => (overrides.absent ? null : { size }));
  const get = vi.fn(async (_key: string, options?: { range?: { offset: number; length: number } }) => {
    const range = options?.range;
    return { body: new Response(range ? DATA.slice(range.offset, range.offset + range.length) : DATA).body };
  });
  return { head, get };
}

function request(path: string, init: { method?: string; range?: string } = {}) {
  return new Request(`https://game.test${path}`, {
    method: init.method ?? 'GET',
    headers: init.range === undefined ? {} : { Range: init.range },
  });
}

function context(path: string, init: { method?: string; range?: string } = {}, disc = bucket()) {
  const req = request(path, init);
  return { ctx: { request: req, env: { PHASE0_DISC: disc } }, disc, req };
}

describe('Phase 0 disc objects', () => {
  it('serves the whole disc from the fixed key', async () => {
    const { ctx, disc } = context('/phase0/disc');
    const response = await onRequest(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DATA);
    expect(disc.head).toHaveBeenCalledExactlyOnceWith('melee-ntsc102.iso');
    expect(disc.get).toHaveBeenCalledExactlyOnceWith('melee-ntsc102.iso');
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Length')).toBe(String(DATA.length));
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('serves the chunk manifest from its own fixed key', async () => {
    const { ctx, disc } = context('/phase0/disc-chunks');
    const response = await onRequest(ctx);
    expect(response.status).toBe(200);
    expect(disc.head).toHaveBeenCalledExactlyOnceWith('disc-chunks.json');
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it.each(RANGED_CASES)('answers %s with a single ranged read', async (range, status, contentRange, body, expected) => {
    const { ctx, disc } = context('/phase0/disc', { range });
    const response = await onRequest(ctx);
    expect(response.status).toBe(status);
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(response.headers.get('Content-Length')).toBe(String(expected.length));
    expect(await response.text()).toBe(body);
    expect(disc.get).toHaveBeenCalledExactlyOnceWith('melee-ntsc102.iso', { range: expected });
  });

  it.each(['bytes=10-', 'bytes=11-99', 'bytes=5-2', 'bytes=-0'])('refuses %s as unsatisfiable', async range => {
    const { ctx, disc } = context('/phase0/disc', { range });
    const response = await onRequest(ctx);
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(disc.get).not.toHaveBeenCalled();
  });

  it.each(['items=0-2', 'bytes=0-2,4-5', 'bytes=abc-def', 'bytes=-'])(
    'ignores the unsupported range header %s and serves the whole object',
    async range => {
      const { ctx, disc } = context('/phase0/disc', { range });
      const response = await onRequest(ctx);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(await response.text()).toBe(DATA);
      expect(disc.get).toHaveBeenCalledExactlyOnceWith('melee-ntsc102.iso');
    },
  );

  it('answers HEAD with the size and no body', async () => {
    const { ctx, disc } = context('/phase0/disc', { method: 'HEAD' });
    const response = await onRequest(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(DATA.length));
    expect(await response.text()).toBe('');
    expect(disc.get).not.toHaveBeenCalled();
  });

  it('answers a ranged HEAD without reading the object', async () => {
    const { ctx, disc } = context('/phase0/disc', { method: 'HEAD', range: 'bytes=0-5' });
    const response = await onRequest(ctx);
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-5/10');
    expect(response.headers.get('Content-Length')).toBe('6');
    expect(disc.get).not.toHaveBeenCalled();
  });

  it('rejects other methods before contacting R2', async () => {
    const { ctx, disc } = context('/phase0/disc', { method: 'POST' });
    const response = await onRequest(ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(disc.head).not.toHaveBeenCalled();
  });

  it('serves nothing else under /phase0', async () => {
    const { ctx, disc } = context('/phase0/disc-chunks.json');
    const response = await onRequest(ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Unknown Phase 0 object' });
    expect(disc.head).not.toHaveBeenCalled();
  });

  it('returns an uncached 503 when the R2 binding is missing', async () => {
    const response = await onRequest({ request: request('/phase0/disc'), env: {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Disc storage unavailable' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns a 404 when the object is not in the bucket', async () => {
    const { ctx } = context('/phase0/disc', {}, bucket({ absent: true }));
    const response = await onRequest(ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Disc object not found' });
  });

  it('returns a 502 without leaking R2 diagnostics when the bucket fails', async () => {
    const disc = bucket();
    disc.head.mockRejectedValueOnce(new Error('bucket melee-phase0-disc account 1234'));
    const response = await onRequest({ request: request('/phase0/disc'), env: { PHASE0_DISC: disc } });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Disc storage failure' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('Phase 0 disc route behind the Access middleware', () => {
  const middleware = createMiddleware(async () => Response.json({ keys: [] }));
  const accessEnv = { ACCESS_AUD: 'application', ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', CF_PAGES_BRANCH: 'main' };

  it('denies a request without an Access token before R2 is touched', async () => {
    const disc = bucket();
    const req = request('/phase0/disc');
    const env = { ...accessEnv, PHASE0_DISC: disc };
    const response = await middleware({ request: req, env, next: async () => onRequest({ request: req, env }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(disc.head).not.toHaveBeenCalled();
  });
});
