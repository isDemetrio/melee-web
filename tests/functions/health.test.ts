import { expect, it } from 'vitest';
import { onRequest } from '../../functions/api/health';

it.each([[undefined, 'unknown'], ['abc123', 'abc123']])('reports commit %s', async (sha, expected) => {
  const response = onRequest({ env: { CF_PAGES_COMMIT_SHA: sha } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', commit: expected });
});
