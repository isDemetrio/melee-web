import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/api/turn-credentials';

const secret = 'test-only-upstream-token';
const env = { TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: secret };
const relay = { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'temporary-user', credential: 'temporary-password' };
const fetchMock = vi.fn();
function invoke(method = 'POST', overrides = {}) {
  return onRequest({ request: new Request('https://game.test/api/turn-credentials', { method }), env: { ...env, ...overrides } });
}
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => Response.json({ iceServers: [relay] }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it.each(['GET', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'])('rejects %s', async method => {
  const response = await invoke(method);
  expect(response.status).toBe(405);
  expect(response.headers.get('Allow')).toBe('POST');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('returns credentials with STUN first, no token, and exact upstream request', async () => {
  fetchMock.mockResolvedValue(Response.json({ iceServers: [relay], diagnostic: secret }));
  const response = await invoke();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.text();
  expect(body).not.toContain(secret);
  expect(JSON.parse(body)).toEqual({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, relay] });
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    'https://rtc.live.cloudflare.com/v1/turn/keys/test-key/credentials/generate-ice-servers',
    { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: '{"ttl":3600}' },
  );
});
it.each([
  [undefined, 3600], ['', 3600], ['invalid', 3600], ['Infinity', 3600], ['0', 3600], ['-1', 3600], ['0.5', 3600],
  ['60', 60], ['60.9', 60], ['86400', 86400], ['999999', 86400],
])('normalizes TTL %s to %s', async (value, expected) => {
  expect((await invoke('POST', { TURN_TTL_SECONDS: value })).status).toBe(200);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ttl: expected });
});
it.each([{ TURN_KEY_ID: '' }, { TURN_KEY_API_TOKEN: undefined }])('fails closed on missing configuration %j', async overrides => {
  const response = await invoke('POST', overrides);
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('encodes the key as a single path segment', async () => {
  await invoke('POST', { TURN_KEY_ID: 'key/with space' });
  expect(fetchMock.mock.calls[0][0]).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key%2Fwith%20space/credentials/generate-ice-servers');
});
it.each([301, 401, 500])('maps upstream %i to 502 without reflecting body', async status => {
  fetchMock.mockResolvedValue(new Response(secret, { status }));
  const response = await invoke();
  expect(response.status).toBe(502);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.text()).not.toContain(secret);
});
it('maps network rejection to 504 without exposing error details', async () => {
  fetchMock.mockRejectedValue(new Error(secret));
  const response = await invoke();
  expect(response.status).toBe(504);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.text()).not.toContain(secret);
});
it.each([
  null, {}, { iceServers: null }, { iceServers: [null] }, { iceServers: [{ urls: 'wrong' }] },
  { iceServers: [{ urls: [7] }] }, { iceServers: [{ ...relay, credential: secret }] },
  { iceServers: [{ ...relay, username: 123 }] }, { iceServers: [{ ...relay, credential: null }] },
])('rejects malformed or secret-reflecting payload %j', async payload => {
  fetchMock.mockResolvedValue(Response.json(payload));
  const response = await invoke();
  expect(response.status).toBe(502);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.text()).not.toContain(secret);
});
it('handles invalid JSON', async () => {
  fetchMock.mockResolvedValue(new Response('{'));
  expect((await invoke()).status).toBe(502);
});
it('includes STUN even when upstream has no entries or only STUN', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ iceServers: [] }));
  expect(await (await invoke()).json()).toEqual({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] });
  fetchMock.mockResolvedValueOnce(Response.json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }));
  expect((await invoke()).status).toBe(200);
});
