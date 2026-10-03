/**
 * Dropping a service worker left behind by an earlier visit.
 *
 * A service worker registered on a previous visit keeps serving the shell out of its own cache,
 * so a deployment never reaches the browser: the page shows yesterday's code while the deploy
 * says otherwise, and every measurement the operator takes on that page is suspect.
 *
 * The published site does not ship `sw.js` at all (`phase0-build.yml` removes it from the dist),
 * so a registration that still controls the page is a leftover with no reason to exist. This drops
 * it, drops its cached shell, and asks for one reload so the load that follows fetches the current
 * deployment.
 *
 * The reload cannot loop, and that is guarded twice: a flag in session storage limits it to once
 * per tab, and once the registration is gone `controller` is null on the next load, so the cleanup
 * does not run again.
 *
 * The dependencies are passed in rather than reached for, so the behaviour above is asserted by
 * tests with fakes instead of described.
 */

export const STALE_SW_GUARD = 'melee-sw-stale-dropped';

/** Only the shell caches are ours to delete; the asset layer keeps its own. */
export const SHELL_CACHE_PREFIX = 'melee-shell';

export interface ServiceWorkerCleanupDeps {
  /** The service worker controlling the current document, or null when none does. */
  readonly controller: unknown | null;
  /** Where the once-per-tab guard is kept. */
  readonly guard: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  readonly getRegistrations: () => Promise<readonly { unregister(): Promise<boolean> }[]>;
  readonly cacheNames: () => Promise<readonly string[]>;
  readonly deleteCache: (name: string) => Promise<boolean>;
  readonly reload: () => void;
  readonly log: (line: string) => void;
}

/**
 * Returns true when a leftover service worker was dropped and a reload is taking over, so the
 * caller must not continue booting (and must not register the worker again on the way out).
 */
export async function dropStaleServiceWorker(deps: ServiceWorkerCleanupDeps): Promise<boolean> {
  if (!deps.controller) return false;
  if (deps.guard.getItem(STALE_SW_GUARD)) return false;

  const registrations = await deps.getRegistrations();
  deps.log(
    `a service worker from an earlier visit controls this page: dropping ${registrations.length} registration(s) and the cached shell`,
  );
  for (const registration of registrations) {
    await registration.unregister();
  }

  const dropped: string[] = [];
  for (const name of await deps.cacheNames()) {
    if (!name.startsWith(SHELL_CACHE_PREFIX)) continue;
    await deps.deleteCache(name);
    dropped.push(name);
  }
  deps.log(`dropped caches: ${dropped.length > 0 ? dropped.join(', ') : 'none'}`);

  // Set last, immediately before the reload, and for one reason only: it is what makes the reload
  // impossible to loop. Set earlier it would also disarm the cleanup for the whole tab after a
  // transient failure, which is not its job.
  deps.guard.setItem(STALE_SW_GUARD, '1');
  deps.reload();
  return true;
}
