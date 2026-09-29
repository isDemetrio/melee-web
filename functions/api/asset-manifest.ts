interface Env { ASSETS_R2: R2Bucket }

export const onRequest = (async ({ request, env }: Pick<EventContext<Env, string, unknown>, 'request' | 'env'>) => {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
  }
  // Unconditional R2 get returns a body or null; stream it without buffering game metadata.
  // https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
  const manifest = await env.ASSETS_R2.get('manifest.json');
  if (manifest === null) {
    return Response.json({ error: 'Asset manifest not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(manifest.body, { headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300',
    'Cross-Origin-Resource-Policy': 'same-origin',
  } });
}) satisfies PagesFunction<Env>;
