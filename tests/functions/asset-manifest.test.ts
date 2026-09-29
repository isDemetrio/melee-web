import { expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/api/asset-manifest';

function context(body: string | null, method = 'GET') {
  const get = vi.fn(async () => body === null ? null : { body: new Response(body).body });
  // Only get/body are exercised; a real R2Bucket is provided by the runtime, not Node.
  const env = { ASSETS_R2: { get } };
  return { ctx: { request: new Request('https://game.test/api/asset-manifest', { method }), env }, get };
}
it('streams the manifest from the exact R2 key', async () => {
  const manifest = { version: 1, assets: [] };
  const { ctx, get } = context(JSON.stringify(manifest));
  const response = await onRequest(ctx);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(manifest);
  expect(response.headers.get('Content-Type')).toBe('application/json');
  expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  expect(get).toHaveBeenCalledExactlyOnceWith('manifest.json');
});
it('returns a clear uncached 404 for an absent manifest', async () => {
  const { ctx } = context(null);
  const response = await onRequest(ctx);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Asset manifest not found' });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('returns an uncached 503 when the R2 binding is missing', async () => {
  const response = await onRequest({ request: new Request('https://game.test/api/asset-manifest'), env: {} });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Asset storage unavailable' });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('rejects non-GET before contacting R2', async () => {
  const { ctx, get } = context(null, 'POST');
  const response = await onRequest(ctx);
  expect(response.status).toBe(405);
  expect(response.headers.get('Allow')).toBe('GET');
  expect(get).not.toHaveBeenCalled();
});
