import type { AppContext } from '../types';

export const onRequest = ({ env }: Pick<AppContext, 'env'>): Response =>
  Response.json({ status: 'ok', commit: env.CF_PAGES_COMMIT_SHA ?? 'unknown' },
    { headers: { 'Cache-Control': 'no-store' } });
