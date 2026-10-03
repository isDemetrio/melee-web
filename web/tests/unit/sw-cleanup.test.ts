/**
 * Dropping the service worker an earlier visit left behind.
 *
 * Why this is asserted rather than described: the trustworthiness of every measurement the
 * operator takes on this page rests on it. If a leftover worker keeps serving the cached shell,
 * he measures yesterday's code and reports it as today's, and nothing downstream can tell.
 *
 * The dependencies are fakes with call logs, so "it unregistered everything" and "it deleted only
 * its own cache" are counts and not opinions. Two tests carry the weight: the one that keeps the
 * asset layer's caches out of it, and the one that says a cleanup which throws must not leave a
 * tab that reloads in a loop.
 */

import { describe, expect, it } from 'vitest';
import {
  SHELL_CACHE_PREFIX,
  STALE_SW_GUARD,
  dropStaleServiceWorker,
} from '../../src/ui/sw-cleanup.js';

interface HarnessOptions {
  controller?: unknown | null;
  guardSet?: boolean;
  registrations?: string[];
  caches?: string[];
  unregisterThrows?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const log = { unregistered: [] as string[], deleted: [] as string[], reloads: 0, lines: [] as string[] };
  const store = new Map<string, string>();
  if (options.guardSet) store.set(STALE_SW_GUARD, '1');

  const deps = {
    controller: options.controller === undefined ? {} : options.controller,
    guard: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
    getRegistrations: async () =>
      (options.registrations ?? ['first', 'second']).map((id) => ({
        unregister: async () => {
          if (options.unregisterThrows) throw new Error('unregister refused');
          log.unregistered.push(id);
          return true;
        },
      })),
    cacheNames: async () => options.caches ?? [`${SHELL_CACHE_PREFIX}-v1`, 'melee-assets-abc123'],
    deleteCache: async (name: string) => {
      log.deleted.push(name);
      return true;
    },
    reload: () => {
      log.reloads += 1;
    },
    log: (line: string) => {
      log.lines.push(line);
    },
  };

  return { deps, log, store };
}

describe('dropStaleServiceWorker', () => {
  it('does nothing when no service worker controls the page', async () => {
    const { deps, log, store } = harness({ controller: null });

    expect(await dropStaleServiceWorker(deps)).toBe(false);
    expect(log.unregistered).toEqual([]);
    expect(log.deleted).toEqual([]);
    expect(log.reloads).toBe(0);
    // The guard stays unset: a page that never needed the cleanup must not spend the tab's one go.
    expect(store.has(STALE_SW_GUARD)).toBe(false);
  });

  it('drops every registration, deletes only the shell cache, and reloads once', async () => {
    const { deps, log, store } = harness();

    expect(await dropStaleServiceWorker(deps)).toBe(true);
    expect(log.unregistered).toEqual(['first', 'second']);
    // The asset layer's cache is not ours to delete, and the shell's is.
    expect(log.deleted).toEqual([`${SHELL_CACHE_PREFIX}-v1`]);
    expect(log.reloads).toBe(1);
    expect(store.get(STALE_SW_GUARD)).toBe('1');
    expect(log.lines.join('\n')).toContain('2 registration(s)');
  });

  it('runs at most once per tab', async () => {
    const { deps, log } = harness({ guardSet: true });

    expect(await dropStaleServiceWorker(deps)).toBe(false);
    expect(log.unregistered).toEqual([]);
    expect(log.reloads).toBe(0);
  });

  it('leaves the guard unset when the cleanup throws, so the next load can retry', async () => {
    const { deps, log, store } = harness({ unregisterThrows: true });

    await expect(dropStaleServiceWorker(deps)).rejects.toThrow('unregister refused');
    expect(log.reloads).toBe(0);
    expect(store.has(STALE_SW_GUARD)).toBe(false);
  });
});
