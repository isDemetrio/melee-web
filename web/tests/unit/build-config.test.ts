/**
 * The build configuration's invariants, asserted where every pull request runs.
 *
 * `phase0-build.yml` used to rebuild the WASM core for any edit to `web/vite.config.ts`, because
 * its spike step runs `npx vite build`. That build is the expensive unit of this repository
 * (5m34s and 5m47s, runs 36965278604 and 36965993838, for the pull request that changed this
 * file), while `ci.yml` has no path filter and reads the same config on every pull request --
 * same two entries, same build, plus the browser tests. What the spike step added for a
 * config-only change was the spike page's own invariants, so those are what is asserted here, in
 * seconds, instead of in a WASM core build.
 *
 * What this does not cover: a config change that breaks the spike page at run time in a way
 * these fields do not name. The spike tests still run on every pull request that touches
 * `web/spike.html`, `web/src/spike/**`, `web/tests/spike/**` or the core.
 */

import { describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config';

/** Only the fields these invariants are about; the config is exported as `defineConfig(...)`. */
const config = viteConfig as unknown as {
  root?: string;
  build: { outDir?: string; rollupOptions: { input: Record<string, string> } };
  worker: { format?: string };
  server: { headers?: Record<string, string> };
  preview: { headers?: Record<string, string> };
};

describe('the build configuration', () => {
  it('writes the shell where the deploy reads it', () => {
    // `scripts/deploy.sh` uploads `web/dist` and refuses to without `_headers`,
    // `scripts/build_web.sh` checks the same directory, and `wrangler.toml` names it as
    // `pages_build_output_dir`. `outDir` is resolved against `root`, so `'.'` plus `'dist'` is
    // `web/dist`; `'../dist'` was the defect the first real deploy refused on (run 36843140022).
    expect(config.root).toBe('.');
    expect(config.build.outDir).toBe('dist');
  });

  it('emits both entries: the shell and the spike page', () => {
    const inputs = Object.values(config.build.rollupOptions.input);
    expect(Object.keys(config.build.rollupOptions.input).sort()).toEqual(['main', 'spike']);
    expect(inputs.some((path) => path.endsWith('/index.html'))).toBe(true);
    expect(inputs.some((path) => path.endsWith('/spike.html'))).toBe(true);
  });

  it('builds the spike workers as ES modules, which is what they are', () => {
    // `web/src/spike/main.ts` and `web/src/spike/opfs-store.ts` construct their workers with
    // `{ type: 'module' }`. With `worker.format: 'iife'` the built page asks for a classic worker
    // and the spike fails at run time, in the only place this repository uses a worker at all.
    expect(config.worker.format).toBe('es');
  });

  it('keeps the isolation headers the threaded core needs', () => {
    // COOP/COEP are what make `crossOriginIsolated` true, which is what SharedArrayBuffer needs.
    // Production sets them in `web/public/_headers`; the dev server and `vite preview` set them
    // here so a local run behaves like production.
    for (const headers of [config.server.headers, config.preview.headers]) {
      expect(headers?.['Cross-Origin-Opener-Policy']).toBe('same-origin');
      expect(headers?.['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    }
  });
});
