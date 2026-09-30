import type { AppContext } from '../types';

// Phase 0 reads exactly two objects out of the private `melee-phase0-disc` bucket: the
// verified NTSC 1.02 disc image, and the chunk manifest `scripts/phase0/disc_chunks.py`
// writes next to it. The object key is chosen here from the request path and is never taken
// from the request itself, so no request can name an object this handler does not know.
//
// One catch-all file rather than one file per route: `wrangler pages functions build` treats
// every `.ts` file under `functions/` as a route, so a shared helper module cannot live in
// there, and the range logic below must not be copied into two files.
// https://developers.cloudflare.com/pages/functions/routing/
const OBJECTS: Record<string, { key: string; contentType: string }> = {
  '/phase0/disc': { key: 'melee-ntsc102.iso', contentType: 'application/octet-stream' },
  '/phase0/disc-chunks': { key: 'disc-chunks.json', contentType: 'application/json' },
};

// One explicit range only. The page asks for `bytes=<offset>-<offset+16 MiB-1>` to resume a
// download, so a multi-range or an unknown unit is ignored and the whole object is served,
// which is what HTTP requires for a range the origin does not understand.
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

interface ResolvedRange {
  offset: number;
  length: number;
}

function resolveRange(header: string | null, size: number): ResolvedRange | 'unsatisfiable' | null {
  if (header === null) return null;
  const match = SINGLE_RANGE.exec(header.trim());
  if (match === null) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    // A suffix range asks for the last N bytes; N = 0 is unsatisfiable by definition.
    const suffix = Number(last);
    if (suffix === 0) return 'unsatisfiable';
    const offset = Math.max(size - suffix, 0);
    return { offset, length: size - offset };
  }
  const offset = Number(first);
  if (!Number.isFinite(offset) || offset >= size) return 'unsatisfiable';
  // An end past the last byte is clamped, not refused; `end < offset` is a malformed range.
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isFinite(end) || end < offset) return 'unsatisfiable';
  return { offset, length: end - offset + 1 };
}

function refuse(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export const onRequest = async ({ request, env }: Pick<AppContext, 'request' | 'env'>): Promise<Response> => {
  const object = OBJECTS[new URL(request.url).pathname];
  if (object === undefined) return refuse(404, 'Unknown Phase 0 object');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refuse(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }
  // A deployment without the R2 binding is a configuration fault, not a missing disc.
  if (!env.PHASE0_DISC) return refuse(503, 'Disc storage unavailable');
  const headers = {
    'Content-Type': object.contentType,
    // Never cached: the disc is immutable but its binding is not, and the page resumes by
    // byte offset from its own OPFS copy, not from any proxy cache.
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Accept-Ranges': 'bytes',
  };
  try {
    // Metadata first, so the range is resolved against the real size and the read below is
    // always a single explicit range. This is also what keeps an out-of-bounds request from
    // depending on how R2 itself answers an unsatisfiable range.
    const head = await env.PHASE0_DISC.head(object.key);
    if (head === null) return refuse(404, 'Disc object not found');
    const range = resolveRange(request.headers.get('Range'), head.size);
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${head.size}` },
      });
    }
    if (range === null) {
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(head.size) } });
      }
      const whole = await env.PHASE0_DISC.get(object.key);
      if (whole === null) return refuse(404, 'Disc object not found');
      return new Response(whole.body, { status: 200, headers: { ...headers, 'Content-Length': String(head.size) } });
    }
    const contentRange = `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`;
    const partial = {
      ...headers,
      'Content-Range': contentRange,
      'Content-Length': String(range.length),
    };
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers: partial });
    const body = await env.PHASE0_DISC.get(object.key, { range });
    if (body === null) return refuse(404, 'Disc object not found');
    return new Response(body.body, { status: 206, headers: partial });
  } catch {
    // Never forward R2 diagnostics: they can name the bucket and the account.
    return refuse(502, 'Disc storage failure');
  }
};
