import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The shell is served from Cloudflare Pages in production. Three things matter here:
 *
 * 1. COOP/COEP headers are required for SharedArrayBuffer, which the threaded WASM
 *    core needs. Production sets them in `web/public/_headers`, which Vite copies into the
 *    build; the dev server and `vite preview` set them here so a local run behaves like
 *    production.
 * 2. The build lands in `web/dist`. `outDir` is relative to `root`, which is this
 *    directory, and `web/dist` is what `scripts/deploy.sh` uploads (it refuses without
 *    `_headers`), what `scripts/build_web.sh` checks after the build, and what
 *    `wrangler.toml` names as `pages_build_output_dir`. It used to be `../dist`, one level
 *    above the shell, so all three looked at a directory the build never wrote.
 * 3. `worker.format = 'es'` because the simulation worker is an ES module worker.
 */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    rollupOptions: { input: {
      main: fileURLToPath(new URL('./index.html', import.meta.url)),
      spike: fileURLToPath(new URL('./spike.html', import.meta.url)),
    } },
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    headers: isolationHeaders,
  },
  preview: {
    port: 4173,
    headers: isolationHeaders,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
} as never);
