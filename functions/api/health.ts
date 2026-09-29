interface Env { CF_PAGES_COMMIT_SHA?: string }

export const onRequest = (({ env }: Pick<EventContext<Env, string, unknown>, 'env'>) =>
  Response.json({ status: 'ok', commit: env.CF_PAGES_COMMIT_SHA ?? 'unknown' },
    { headers: { 'Cache-Control': 'no-store' } })) satisfies PagesFunction<Env>;
